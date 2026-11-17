"""Run real JPEG inference on the connected S3; test events never enter cloud outbox."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import time
from pathlib import Path
import cv2
import serial


class Board:
    def __init__(self, port, log):
        self.link=serial.Serial(port=None,baudrate=921600,timeout=.15,write_timeout=15)
        self.link.port=port;self.link.dtr=True;self.link.rts=False;self.link.open()
        self.log=log

    def close(self): self.link.close()

    def wait(self,prefix,timeout=40):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            line=self.link.readline().decode('utf-8','replace').strip()
            if not line: continue
            if self.log: self.log.write(line+'\n');self.log.flush()
            start=line.find(prefix)
            if start>=0:return line[start:]
            if 'PG_' in line and ('ERROR' in line):raise RuntimeError(line)
            if 'Guru Meditation Error' in line or 'assert failed:' in line:
                raise RuntimeError('Board fault during candidate test: '+line)
        raise TimeoutError('Board did not return '+prefix)

    def command(self,text,prefix,timeout=40):
        self.link.write((text+'\n').encode());self.link.flush()
        return self.wait(prefix,timeout)

    def transfer(self,header,data,result,timeout=60):
        self.command(header,'PG_RX_READY')
        acknowledged=0
        # Keep the outstanding USB window below the firmware's 8KB RX ring.
        # Larger host writes can overflow that ring during Wi-Fi scheduling.
        for offset in range(0,len(data),4096):
            block=data[offset:offset+4096];self.link.write(block);self.link.flush()
            target=offset+len(block)
            while acknowledged<target:
                ack=int(self.wait('PG_RX ',20).split()[-1])
                if ack<=acknowledged or ack>target or ack-acknowledged>1024:
                    raise RuntimeError(f'Transfer acknowledgement mismatch: previous {acknowledged}, target {target}, received {ack}')
                acknowledged=ack
        return self.wait(result,timeout)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',required=True)
    parser.add_argument('--model',type=Path)
    parser.add_argument('--runtime-mode',choices=('single','dual'))
    parser.add_argument('--internal-bytes',type=int,choices=(0,8192,16384,24576,32768,49152,65536,81920,98304))
    parser.add_argument('--decode-limit',type=int,choices=(0,128,256,384,640))
    parser.add_argument('--save-model',action='store_true')
    parser.add_argument('--replace-model',action='store_true',help='replace the model file only after upload/hash verification; keeps device binding and event files')
    parser.add_argument('--video',type=Path)
    parser.add_argument('--stride',type=int,default=6)
    parser.add_argument('--limit',type=int,default=0)
    parser.add_argument('--start-frame',type=int,default=0)
    parser.add_argument('--max-side',type=int,default=640,help='Test JPEG maximum side; both decoded dimensions must remain at least 240')
    parser.add_argument('--jpeg-quality',type=int,choices=range(40,96),default=80,metavar='40..95',help='Evaluate lossy input compression separately from source resolution')
    parser.add_argument('--source-rotation',type=int,choices=(0,90,180,270),default=0)
    parser.add_argument('--correction',type=int,choices=(-1,0,90,180,270),default=0,help='-1 means automatic')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--test-threshold',type=int)
    parser.add_argument('--test-escalation',type=int,default=300)
    parser.add_argument('--readback',action='store_true',help='read back this session local records and target crops with per-chunk SHA-256 checks')
    parser.add_argument('--keep-test-mode',action='store_true',help='keep production inference paused while evaluating unvalidated model/runtime candidates')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    with (args.output/'serial.log').open('a',encoding='utf-8') as log:
        board=Board(args.port,log)
        try:
            board.command('STATUS','s3_model=',15)
            if args.decode_limit is not None:
                board.command(f'PREPROCESS_LIMIT {args.decode_limit}','PG_PREPROCESS_LIMIT')
            if args.runtime_mode is not None or args.internal_bytes is not None:
                board.command(f'MODEL_OPTIONS {int(args.runtime_mode=="dual")} {args.internal_bytes or 0}','PG_MODEL_OPTIONS')
            if args.model:
                if args.model.suffix!='.espdl': raise ValueError('Only validated .espdl model files can be uploaded')
                metadata=args.model.with_suffix('.json')
                if metadata.exists() and json.loads(metadata.read_text(encoding='utf-8')).get('deployment_valid') is False:
                    raise ValueError('Model conversion reported an unsafe deployment')
                data=args.model.read_bytes();digest=hashlib.sha256(data).hexdigest();started=time.monotonic()
                board.transfer(f'MODEL_RAM {len(data)} {digest}',data,'PG_MODEL_LOADED',90)
                print(json.dumps({'model_sha256':digest,'model_bytes':len(data),'transfer_and_load_seconds':round(time.monotonic()-started,3)}),flush=True)
            if args.save_model:board.command('MODEL_SAVE_REPLACE'if args.replace_model else'MODEL_SAVE','PG_MODEL_SAVED',90)
            if args.video:
                session=board.command('TEST_BEGIN','PG_TEST_READY').split()[-1]
                if args.test_threshold:board.command(f'TEST_POLICY {args.test_threshold} {args.test_escalation}','PG_TEST_POLICY')
                capture=cv2.VideoCapture(str(args.video))
                capture.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
                if not capture.isOpened():raise RuntimeError('Video failed to open')
                fps=capture.get(cv2.CAP_PROP_FPS)
                if fps<=0:raise RuntimeError('Source video FPS unavailable')
                rows=[];index=0;started=time.monotonic()
                with (args.output/'inferences.jsonl').open('w',encoding='utf-8') as output:
                    while True:
                        ok,image=capture.read()
                        if not ok:break
                        current=index;index+=1
                        if current<args.start_frame or (current-args.start_frame)%args.stride:continue
                        height,width=image.shape[:2];scale=min(1,args.max_side/max(width,height))
                        image=cv2.resize(image,(round(width*scale),round(height*scale)))
                        if min(image.shape[:2])<240:raise RuntimeError('Video image would fall below 240 pixels on one axis')
                        if args.source_rotation:image=cv2.rotate(image,{90:cv2.ROTATE_90_CLOCKWISE,180:cv2.ROTATE_180,270:cv2.ROTATE_90_COUNTERCLOCKWISE}[args.source_rotation])
                        ok,jpeg=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,args.jpeg_quality])
                        if not ok:raise RuntimeError('JPEG encode failed')
                        media_ms=round(current/fps*1000);data=jpeg.tobytes();call=time.monotonic()
                        reply=board.transfer(f'TEST_FRAME {len(data)} {media_ms} {args.correction} 0',data,'PG_RESULT ',90)
                        row=json.loads(reply[len('PG_RESULT '):]);row.update(frame=current,roundtrip_ms=round((time.monotonic()-call)*1000,2),jpeg_sha256=hashlib.sha256(data).hexdigest())
                        rows.append(row);output.write(json.dumps(row,ensure_ascii=False)+'\n');output.flush()
                        print(json.dumps({key:row.get(key)for key in('frame','people','processing_ms','inference_ms','orientation','free_psram','event_updates')},ensure_ascii=False),flush=True)
                        if args.limit and len(rows)>=args.limit:break
                capture.release()
                report={'is_test':True,'board_session':session,'video_name':args.video.name,'source_fps':fps,'source_rotation':args.source_rotation,'correction':args.correction,'fresh_inferences':len(rows),'wall_seconds':round(time.monotonic()-started,2),'people_frames':sum(row.get('people',0)>0 for row in rows),'multi_person_frames':sum(row.get('people',0)>=2 for row in rows),'phone_candidate_frames':sum(any(risk['kind']=='phone_to_ear' for risk in row.get('risks',[])) for row in rows),'model_inference_mean_ms':sum(row['inference_ms'] for row in rows)/max(1,len(rows)),'processing_mean_ms':sum(row['processing_ms'] for row in rows)/max(1,len(rows)),'min_free_psram':min((row['free_psram']for row in rows),default=None),'min_internal_heap':min((row['min_heap']for row in rows),default=None),'minimum_psram_since_boot':min((row.get('min_psram',row['free_psram'])for row in rows),default=None),'test_threshold':args.test_threshold,'production_policy_changed':False,'external_alerts_sent':False}
                board.command('TEST_PAUSE'if args.keep_test_mode else'TEST_END','PG_TEST_PAUSED'if args.keep_test_mode else'PG_TEST_END')
                if args.readback:
                    directory=args.output/'board-files';directory.mkdir(exist_ok=True)
                    index=json.loads(board.command('TEST_INDEX '+session,'PG_INDEX ')[len('PG_INDEX '):])
                    for item in index['items']:
                        path=item['path']
                        if item['directory']or not path.startswith('/tests/'+session+'/')or '..'in path:continue
                        data=bytearray()
                        while len(data)<item['bytes']:
                            part=json.loads(board.command(f'TEST_READ {path} {len(data)}','PG_FILE ')[len('PG_FILE '):])
                            chunk=base64.b64decode(part['data'],validate=True)
                            if part['offset']!=len(data)or not chunk or hashlib.sha256(chunk).hexdigest()!=part['sha256']:raise RuntimeError('Board file readback validation failed')
                            data.extend(chunk)
                        if len(data)!=item['bytes']:raise RuntimeError('Board file size mismatch')
                        (directory/Path(path).name).write_bytes(data)
                    report['readback_files']=[path.name for path in directory.iterdir()]
                (args.output/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False),flush=True)
            board.command('TEST_PAUSE'if args.keep_test_mode else'TEST_END','PG_TEST_PAUSED'if args.keep_test_mode else'PG_TEST_END')
        finally:board.close()


if __name__=='__main__':main()
