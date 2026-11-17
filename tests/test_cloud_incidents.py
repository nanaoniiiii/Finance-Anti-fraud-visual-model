import json
from poseguard.cloud.edge import IncidentMonitor,CloudRelay


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


def test_raised_policy_keeps_old_evidence_without_blocking_new_alerts(tmp_path):
    config=tmp_path/'device.json'
    config.write_text(json.dumps(dict(server_url='https://alerts.example.test',device_token='test',data_directory=str(tmp_path/'data'),rules=dict(frame_threshold=300))))
    relay=CloudRelay(config)
    for index in range(20):
        (relay.directory/'outbox'/f'a{index:02}.json').write_text(json.dumps(dict(observed_frames=101,event_id=str(index))))
    newest=relay.directory/'outbox'/'z.json';newest.write_text(json.dumps(dict(observed_frames=301,event_id='new')))
    selected=list(relay.pending_payloads())
    assert len(selected)==1 and selected[0][0]==newest
    assert len(list((relay.directory/'outbox').glob('*.json')))==21
    relay.config['rules']['frame_threshold']=100
    assert len(list(relay.pending_payloads()))==12


def test_malformed_outbox_is_retained_in_quarantine_while_valid_data_continues(tmp_path):
    config=tmp_path/'device.json';config.write_text(json.dumps(dict(server_url='https://alerts.example.test',device_token='test',data_directory=str(tmp_path/'data'))))
    relay=CloudRelay(config);bad=relay.directory/'outbox'/'a.json';bad.write_text('{invalid')
    good=relay.directory/'outbox'/'b.json';good.write_text(json.dumps(dict(observed_frames=101)))
    assert [p for p,_ in relay.pending_payloads()]==[good]
    assert (relay.directory/'rejected'/'a.json').read_text()=='{invalid'
