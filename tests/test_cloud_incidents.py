import json
from poseguard.cloud.edge import IncidentMonitor


def observation(track=1, risk="phone_to_ear", state="candidate", observed=True):
    return {"track_id":track,"risk_kind":risk,"state":state,"observed":observed,"bbox":[1,2,31,82]}


def test_101_boundary_candidate_included_and_no_duplicate_updates(tmp_path):
    monitor=IncidentMonitor(tmp_path)
    for index in range(100):
        assert monitor.update([observation()],timestamp=index/30)==[]
    event=monitor.update([observation()],timestamp=100/30)
    assert len(event)==1 and event[0]["observed_frames"]==101 and event[0]["severity"]==1
    assert monitor.update([observation()],timestamp=101/30)==[]
    assert len(list((tmp_path/'outbox').glob('*.json')))==1


def test_risks_and_tracks_separate_predicted_frames_not_counted(tmp_path):
    monitor=IncidentMonitor(tmp_path)
    for index in range(100):
        monitor.update([observation(),observation(2),observation(risk="multi_person"),observation(3,observed=False)],timestamp=index/30)
    result=monitor.update([observation()],timestamp=3.4)
    assert len(result)==1 and result[0]["track_id"]==1
    assert len(monitor.active)==3


def test_confirmed_transition_and_301_escalation(tmp_path):
    monitor=IncidentMonitor(tmp_path)
    for index in range(101): monitor.update([observation()],timestamp=index/30)
    result=monitor.update([observation(state="alert")],timestamp=102/30)
    assert result[0]["severity"]==2 and result[0]["update_type"]=="escalated"
    for index in range(103,301): monitor.update([observation(state="alert")],timestamp=index/30)
    result=monitor.update([observation(state="alert")],timestamp=301/30)
    assert result[0]["severity"]==3 and result[0]["observed_frames"]==301
    records=[json.loads(line) for line in (tmp_path/'incidents.jsonl').read_text(encoding='utf-8').splitlines()]
    assert any(row['action']=='staff_intervention_requested' for row in records)


def test_clear_and_camera_reset_preserve_outbox_and_start_new_episode(tmp_path):
    monitor=IncidentMonitor(tmp_path)
    for index in range(101): monitor.update([observation()],timestamp=index/30)
    old=next(iter(monitor.active.values()))['event_id']
    monitor.reset('camera_lost')
    assert len(list((tmp_path/'outbox').glob('*.json')))==2
    monitor.update([observation()],timestamp=5)
    new=next(iter(monitor.active.values()))
    assert new['event_id']!=old and new['count']==1
    monitor.update([],timestamp=8)
    assert not monitor.active


def test_snapshot_is_cropped_callback_and_persisted_at_threshold(tmp_path):
    calls=[]
    def capture(box,path):
        calls.append(box)
        from PIL import Image
        Image.new('RGB',(30,80),(30,60,90)).save(path)
    monitor=IncidentMonitor(tmp_path,snapshot=capture)
    for index in range(101): monitor.update([observation()],timestamp=index/30)
    queued=json.loads(next((tmp_path/'outbox').glob('*.json')).read_text(encoding='utf-8'))
    assert queued['snapshot']['data_base64'] and len(calls)==2
    assert len(list((tmp_path/'evidence').rglob('*.jpg')))==2
