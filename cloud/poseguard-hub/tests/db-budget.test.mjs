import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {nextUtcDay,noteReadQuota,readQuotaExceeded,readQuotaResponse,notificationTotals,offlineChecksAllowed} from '../worker/db-budget.js';

test('D1 daily quota returns retryable 503 until UTC reset; other errors keep their handling',async()=>{
  const env={DB:{}};
  const now=Date.parse('2026-11-15T18:00:00Z');
  assert.equal(noteReadQuota(env,new Error('SQLITE constraint'),now),0);
  assert.equal(readQuotaResponse(env,now),null);
  const error=new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade or wait");
  assert.equal(readQuotaExceeded(error),true);
  assert.equal(noteReadQuota(env,error,now),Date.parse('2026-11-16T00:00:00Z'));
  const response=readQuotaResponse(env,now);
  assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'21600');
  assert.equal((await response.json()).code,'cloud_read_quota');
  assert.equal(readQuotaResponse(env,nextUtcDay(now)),null);
});

test('Notification totals remain correct across backfill, status updates, retries and deletion',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../migrations/0001.sql',import.meta.url),'utf8'));
  const insert=db.prepare("INSERT INTO notification_jobs(id,channel,target,payload_json,status,created_at,updated_at)VALUES(?,'email','test@example.test','{}',?,'2026-11-15','2026-11-15')");
  for(let i=0;i<2000;i++)insert.run('job-'+i,i%4===0?'blocked':i%4===1?'failed':'sent');
  db.exec(fs.readFileSync(new URL('../migrations/0011_read_budget.sql',import.meta.url),'utf8'));
  function verify(){
    for(const status of ['blocked','failed','pending','sending','sent']) {
      const actual=db.prepare('SELECT COALESCE(total,0) AS n FROM notification_job_counts WHERE status=?').get(status)?.n||0;
      assert.equal(actual,db.prepare('SELECT COUNT(*) AS n FROM notification_jobs WHERE status=?').get(status).n);
    }
  }
  verify();insert.run('new-pending','pending');verify();
  db.exec("UPDATE notification_jobs SET status='sending' WHERE id='new-pending'; UPDATE notification_jobs SET attempts=attempts+1 WHERE id='new-pending'; UPDATE notification_jobs SET status='failed' WHERE id='new-pending'");verify();
  db.exec("UPDATE notification_jobs SET status='sent' WHERE status='blocked';DELETE FROM notification_jobs WHERE status='failed'");verify();
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT total FROM notification_job_counts WHERE status IN ('blocked','failed')").all();
  assert.ok(plan.some(row=>row.detail.includes('INDEX')));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_job_counts').get().n,5);
  db.close();
});

test('Rolling deployment caches old notification aggregation, but does not swallow quota errors',async()=>{
  let scans=0;
  const env={DB:{prepare(sql){return{first:async()=>{
    if(sql.includes('notification_job_counts'))throw new Error('D1_ERROR: no such table: notification_job_counts');
    scans++;return{blocked:3,failed:2};
  }};}}};
  assert.deepEqual(await notificationTotals(env,1000),{blocked:3,failed:2});
  await notificationTotals(env,2000);assert.equal(scans,1);
  await notificationTotals(env,62000);assert.equal(scans,2);
  const broken={DB:{prepare(){return{first:async()=>{throw new Error('D1_ERROR: daily read limit');}};}}};
  await assert.rejects(()=>notificationTotals(broken),/daily read/);
});

test('Offline notifications wait for reconnect grace after a cloud outage',async()=>{
  const env={ROOMS:{idFromName:()=>'',get:()=>({fetch:async()=>Response.json({until:1000000})})}};
  assert.equal(await offlineChecksAllowed(env,1000001),false);
  assert.equal(await offlineChecksAllowed(env,1300000),true);
});
test('Reset propagation and an externally restored quota cannot latch the API off for another day',async()=>{
  const env={DB:{}},error=new Error("D1_ERROR: account exceeded D1 free tier daily row read limit");
  const time=Date.parse('2026-11-16T00:00:02Z');
  assert.equal(noteReadQuota(env,error,time),time+60000);
  assert.equal(readQuotaResponse(env,time).headers.get('Retry-After'),'60');
  assert.equal(readQuotaResponse(env,time+60000),null);
  const daytime=Date.parse('2026-11-16T12:00:00Z');noteReadQuota(env,error,daytime);
  assert.equal(readQuotaResponse(env,daytime+60000),null,'probe after a minute even if the expected reset is later');
});
