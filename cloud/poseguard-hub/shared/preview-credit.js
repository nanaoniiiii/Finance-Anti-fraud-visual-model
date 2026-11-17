export const JPEG_CREDIT_BYTES=256*1024;
export function jpegCredit(value) {return Number.isSafeInteger(value)?Math.max(1,Math.min(8,value)):1;}
export function sourceCredit(value) {return Number.isSafeInteger(value)?Math.max(1,Math.min(12,value)):1;}
export function clearCredits(value) {
  value.outstanding=[];value.outstandingAt=[];value.outstandingBytes=[];value.sentAt=0;
}
export function consumeCredit(value,sequence,now) {
  const index=value.outstanding.indexOf(sequence);
  if(index<0)return false;
  const elapsed=Math.max(0,now-(value.outstandingAt?.[index]??value.sentAt));
  value.consumeRtt=value.consumeRtt?value.consumeRtt*.7+elapsed*.3:elapsed;
  const count=value.lastCodec==='jpeg'&&jpegCredit(value.jpegWindow)>1?1:index+1;
  const first=count===1?index:0;
  value.outstanding.splice(first,count);
  value.outstandingAt?.splice(first,count);
  value.outstandingBytes?.splice(first,count);
  value.sentAt=value.outstandingAt?.[0]||0;
  return true;
}
export function hasCredit(value,codec,bytes) {
  const limit=codec==='h264'?4:jpegCredit(value.jpegWindow);
  const queued=(value.outstandingBytes||[]).reduce((sum,size)=>sum+size,0);
  return value.outstanding.length<limit && (!value.outstanding.length||queued+bytes<=JPEG_CREDIT_BYTES);
}
export function spendCredit(value,sequence,bytes,now,codec) {
  value.outstandingAt??=[];value.outstandingBytes??=[];
  value.outstanding.push(sequence);value.outstandingAt.push(now);value.outstandingBytes.push(bytes);
  value.sentAt=value.outstandingAt[0];value.lastCodec=codec;
}
