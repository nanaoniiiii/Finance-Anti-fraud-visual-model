// Expiring CDN routes, obtained server-side rather than trusting a poisoned
// local resolver. Devices still verify the configured host and its TLS CA.
const cached = new Map();
export function publicIpv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const [a,b,c,d] = value.split('.').map(Number);
  if ([a,b,c,d].some(n => n > 255)) return false;
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
}
export async function networkHints(env, fetcher=fetch) {
  const name = env.PREVIEW_CDN_DNS_NAME;
  if (typeof name !== 'string' || !/^[a-z0-9.-]+\.workers\.dev$/.test(name)) return undefined;
  const existing = cached.get(name);
  if (existing && existing.expires_unix > Date.now()/1000 + 5) return existing;
  try {
    const response = await fetcher('https://cloudflare-dns.com/dns-query?type=A&name=' + encodeURIComponent(name), {
      headers: {Accept: 'application/dns-json'}, signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const value = await response.json();
    if (value.Status !== 0 || value.TC || !Array.isArray(value.Answer)) return undefined;
    const answers = value.Answer.filter(row => row.type === 1 && publicIpv4(row.data) && Number(row.TTL) > 0).slice(0,4);
    if (!answers.length) return undefined;
    const ttl = Math.min(300, ...answers.map(row => Number(row.TTL)));
    const result = {host: new URL(env.PUBLIC_ORIGIN).hostname,
      addresses: [...new Set(answers.map(row => row.data))],
      expires_unix: Math.floor(Date.now()/1000 + ttl)};
    cached.set(name, result); return result;
  } catch {return undefined;}
}
