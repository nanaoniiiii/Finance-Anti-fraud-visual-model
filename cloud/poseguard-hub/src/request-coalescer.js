export function coalesceReads(perform) {
  const pending=new Map();
  function request(path,options={}) {
    const read=(options.method||'GET').toUpperCase()==='GET';
    if(!read){pending.clear();return Promise.resolve().then(()=>perform(path,options)).finally(()=>pending.clear());}
    if(pending.has(path))return pending.get(path);
    const result=Promise.resolve().then(()=>perform(path,options)).finally(()=>{if(pending.get(path)===result)pending.delete(path);});
    pending.set(path,result);return result;
  }
  request.clear=()=>pending.clear();
  return request;
}
