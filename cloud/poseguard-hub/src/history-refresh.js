// Changes and explicit actions refresh history immediately. An unchanged idle
// page only refreshes history periodically, while device health stays current.
export function needsHistory(snapshot,cursor,{passive=false,time=Date.now()}={}) {
  return !passive || !snapshot || snapshot.cursor!==cursor ||
    time-snapshot.loadedAt>=120000;
}
