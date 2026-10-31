// Worker 單元測試：模擬 Access 憑證、certs 端點與 Apps Script。執行：node tests/worker.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(path.join(here, '../worker/index.js')).href)).default;

const TEAM = 'https://wildervalley.cloudflareaccess.com';
const AUD = 'test-aud';
const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const good = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const evil = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'k1', alg: 'RS256' };

const b64u = buf => Buffer.from(buf).toString('base64url');
async function makeJwt(claims, { key = good.privateKey, kid = 'k1' } = {}) {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const okClaims = { iss: TEAM, aud: [AUD], exp: now + 3600, email: 'Field.User@Gmail.com' };

let calls = [];
let scriptReply = () => new Response('{"ok":true,"x":1}', { headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  calls.push({ url, method: init.method || 'GET', body: init.body });
  return scriptReply();
};
const env = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/ABC/exec', API_TOKEN: 'sekret',
  ASSETS: { fetch: req => new Response('asset:' + new URL(req.url).pathname) },
};
const req = (p, { jwt, method = 'GET', body } = {}) =>
  new Request('https://catpatrol.example.workers.dev' + p, { method, body, headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const status = async (p, opts) => (await worker.fetch(req(p, opts), env)).status;

check('static file goes to ASSETS', (await (await worker.fetch(req('/index.html'), env)).text()) === 'asset:/index.html');
check('no JWT -> 401', await status('/api/bootstrap') === 401);

const jwt = await makeJwt(okClaims);
let r = await worker.fetch(req('/api/bootstrap', { jwt }), { ...env, API_TOKEN: undefined });
check('missing secret -> 500', r.status === 500 && (await r.json()).error.includes('尚未設定'));

calls = [];
r = await worker.fetch(req('/api/bootstrap', { jwt }), env);
const u = new URL(calls[0]?.url || 'http://x');
check('bootstrap forwarded with token + action', r.status === 200 && u.searchParams.get('token') === 'sekret'
  && u.searchParams.get('action') === 'bootstrap' && calls[0].method === 'GET');
check('bootstrap carries verified email, lowercased', u.searchParams.get('user') === 'field.user@gmail.com');
check('bootstrap body passthrough + no-store', JSON.stringify(await r.json()) === '{"ok":true,"x":1}'
  && r.headers.get('Cache-Control') === 'no-store');

calls = [];
r = await worker.fetch(req('/api/photo?id=FILE_1', { jwt }), env);
const ph = new URL(calls[0]?.url || 'http://x');
check('photo forwarded with action=photo + id + token', r.status === 200 && ph.searchParams.get('action') === 'photo'
  && ph.searchParams.get('id') === 'FILE_1' && ph.searchParams.get('token') === 'sekret');
check('photo without login -> 401', await status('/api/photo?id=FILE_1') === 401);

calls = [];
const payload = JSON.stringify({ action: 'addRecord', payload: { recordId: 'R1' }, photos: [{ dataBase64: 'x'.repeat(5000) }] });
r = await worker.fetch(req('/api/write', { jwt, method: 'POST', body: payload }), env);
const pu = new URL(calls[0]?.url || 'http://x');
check('write forwarded as POST, token + user in query', r.status === 200 && calls[0].method === 'POST'
  && pu.searchParams.get('token') === 'sekret' && pu.searchParams.get('user') === 'field.user@gmail.com');
check('write body forwarded byte-identical', new TextDecoder().decode(calls[0].body) === payload);

r = await worker.fetch(req('/api/bootstrap', { jwt: await makeJwt({ ...okClaims, aud: ['other'] }) }), env);
check('wrong aud -> 500 mismatch (not login expired)', r.status === 500 && (await r.json()).error.includes('ACCESS_AUD'));
check('wrong iss -> 500 mismatch', await status('/api/bootstrap', { jwt: await makeJwt({ ...okClaims, iss: 'https://evil.cloudflareaccess.com' }) }) === 500);
check('aud as string ok', await status('/api/bootstrap', { jwt: await makeJwt({ ...okClaims, aud: AUD }) }) === 200);
check('expired -> 401', await status('/api/bootstrap', { jwt: await makeJwt({ ...okClaims, exp: now - 10 }) }) === 401);
check('signed by other key -> 401', await status('/api/bootstrap', { jwt: await makeJwt(okClaims, { key: evil.privateKey }) }) === 401);
const [h, , s] = jwt.split('.');
check('tampered payload -> 401', await status('/api/bootstrap', { jwt: `${h}.${b64u(JSON.stringify({ ...okClaims, email: 'x@y.z' }))}.${s}` }) === 401);
check('garbage token -> 401', await status('/api/bootstrap', { jwt: 'a.b.c' }) === 401);
check('unknown kid -> 401', await status('/api/bootstrap', { jwt: await makeJwt(okClaims, { kid: 'nope' }) }) === 401);

scriptReply = () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
r = await worker.fetch(req('/api/bootstrap', { jwt }), env);
check('Apps Script HTML -> 502 with hint', r.status === 502 && (await r.json()).error.includes('所有人'));
scriptReply = () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });

check('unknown api path -> 404', await status('/api/nope', { jwt }) === 404);
check('GET on /api/write -> 404', await status('/api/write', { jwt }) === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
