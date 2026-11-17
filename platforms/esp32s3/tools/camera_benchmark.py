"""Measure fresh local camera inferences, including preprocessing and pose rules.

Uses a dedicated firmware benchmark mode: real camera and real model, with
production incident upload suppressed. Leaves the detector paused afterwards.
Upload an evaluated model with board_video_test.py --keep-test-mode first.
"""
import argparse
import json
import re
import statistics
import time
from pathlib import Path
from board_video_test import Board


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',required=True)
    parser.add_argument('--seconds',type=int,default=120)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 10<=args.seconds<=3600:parser.error('Use a 10-3600 second sample')
    args.output.mkdir(parents=True,exist_ok=True)
    with (args.output/'serial.log').open('w',encoding='utf-8')as log:
        board=Board(args.port,log)
        rows=[];started=0
        def sample():
            line=board.command('STATUS','s3_model=',20)
            return {key:float(value)for key,value in re.findall(r'([a-z0-9_]+)=([0-9.]+)',line)}
        try:
            board.command('BENCH_BEGIN','PG_BENCH_READY')
            warmup=time.monotonic()+5
            while time.monotonic()<warmup: sample();time.sleep(.5)
            first=sample();started=time.monotonic();rows=[];previous=first;previous_time=started
            while time.monotonic()-started<args.seconds:
                time.sleep(min(2,max(0,args.seconds-(time.monotonic()-started))))
                row=sample();stamp=time.monotonic();elapsed=stamp-previous_time
                if row.get('s3_model')!=1 or row.get('camera')!=1 or row.get('benchmark_mode')!=1:
                    raise RuntimeError('Camera/model benchmark stopped unexpectedly')
                row.update(elapsed_seconds=stamp-started,
                           interval_local_fps=(row['inference_frames']-previous['inference_frames'])/elapsed,
                           interval_capture_fps=(row['captured_frames']-previous['captured_frames'])/elapsed)
                rows.append(row);previous=row;previous_time=stamp
                if len(rows)%10==0:print(json.dumps({'seconds':round(row['elapsed_seconds'],1),'local_fps':round(row['interval_local_fps'],3)}),flush=True)
            elapsed=time.monotonic()-started
            inferences=rows[-1]['inference_frames']-first['inference_frames']
            captures=rows[-1]['captured_frames']-first['captured_frames']
            if not 0<inferences<=captures+1:raise RuntimeError('Camera/inference count consistency failed')
            summary={'is_test':True,'source':'physical_xiao_sense_camera','wall_seconds':elapsed,
                     'fresh_local_inferences':int(inferences),'captured_frames':int(captures),
                     'complete_local_fps':inferences/elapsed,'camera_capture_fps':captures/elapsed,
                     'min_sample_interval_fps':min(row['interval_local_fps']for row in rows),
                     'max_sample_interval_fps':max(row['interval_local_fps']for row in rows),
                     'sampled_processing_mean_ms':statistics.mean(row['processing_ms']for row in rows),
                     'min_internal_heap':min(row['heap_min']for row in rows),
                     'min_free_psram':min(row['psram_free']for row in rows),
                     'production_events_suppressed':True,'source_frames_interpolated':False,
                     'offloaded_inference':False}
            (args.output/'samples.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
            (args.output/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
            print(json.dumps(summary),flush=True)
        except BaseException as error:
            (args.output/'failed.json').write_text(json.dumps({'error':str(error),'elapsed_seconds':time.monotonic()-started if started else 0,'samples':rows},indent=2),encoding='utf-8')
            raise
        finally:
            try:board.command('BENCH_END','PG_BENCH_PAUSED')
            except Exception as error:
                (args.output/'shutdown-error.txt').write_text(str(error),encoding='utf-8')
            finally:board.close()


if __name__=='__main__':main()
