import hub from '../worker/index.js';
import { body, json } from '../worker/utils.js';
import { acknowledgeArchive, archiveBatch, enableArchiveQueue } from './archive.mjs';
export { EventRoom, PreviewRoom, AgentlyMailRoom } from '../worker/index.js';

export default {
  async fetch(request, env, ctx) {
    const localEnv = env.STATION_OWNER_HASH_B64 ?
      { ...env, OWNER_PASSWORD_HASH: atob(env.STATION_OWNER_HASH_B64) } : env;
    const route = new URL(request.url).pathname;
    if (route.startsWith('/__station_')) {
      if (!env.LOCAL_MAINTENANCE_KEY || request.headers.get('Authorization') !== 'Bearer ' + env.LOCAL_MAINTENANCE_KEY)
        return new Response('Not found', { status: 404 });
      if (route === '/__station_maintenance' && request.method === 'POST') {
        await hub.scheduled({ cron: '*/2 * * * *', scheduledTime: Date.now() }, localEnv, ctx);
        return new Response(null, { status: 204 });
      }
      if (env.DEPLOYMENT_MODE !== 'edge') return new Response('Not found', { status: 404 });
      if (route === '/__station_archive_init' && request.method === 'POST') {
        await enableArchiveQueue(env.DB);
        return json({ ok: true });
      }
      if (route === '/__station_archive' && request.method === 'GET') {
        const include = new URL(request.url).searchParams.get('photos') === '1';
        return json({ records: await archiveBatch(env.DB, include) });
      }
      if (route === '/__station_archive' && request.method === 'POST') {
        await acknowledgeArchive(env.DB, (await body(request, 3000)).accepted);
        return json({ ok: true });
      }
      return new Response('Not found', { status: 404 });
    }
    return hub.fetch(request, localEnv, ctx);
  },
};
