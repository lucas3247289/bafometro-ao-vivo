// Bafômetro ao Vivo — servidor de lembretes por Web Push (Cloudflare Worker)
// Precisa de: banco D1 ligado como DB e um Cron Trigger "* * * * *".
// As chaves VAPID são geradas pelo próprio Worker na primeira chamada e ficam no D1.

const ALLOWED = ['https://lucas3247289.github.io', 'http://127.0.0.1:8766', 'http://localhost:8766'];
const VAPID_SUB = 'https://lucas3247289.github.io/bafometro-ao-vivo/';
const MAX_ENTRIES = 500;

const enc = new TextEncoder();
const b64u = buf => { const u = new Uint8Array(buf); let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const ub64 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    // um lembrete por aparelho e por tipo ("next" = próxima bebida, "water" = copo d'água)
    env.DB.prepare('CREATE TABLE IF NOT EXISTS reminders2 (endpoint TEXT NOT NULL, kind TEXT NOT NULL, sub TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (endpoint, kind))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS reminders2_at ON reminders2 (at)')
  ]);
  ready = true;
}

async function getVapid(env, create) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'vapid'").first();
  if (row) return JSON.parse(row.v);
  if (!create) return null;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
  // INSERT OR IGNORE: se duas chamadas gerarem ao mesmo tempo, vale a primeira
  await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run();
  return JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k = 'vapid'").first()).v);
}

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

// Criptografia aes128gcm (RFC 8291) + autenticação VAPID (RFC 8292)
async function vapidAuth(endpoint, vapid) {
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUB })));
  const pk = await crypto.subtle.importKey('jwk', vapid.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pk, enc.encode(h + '.' + c));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${vapid.pub}`;
}

// Push sem conteúdo: não precisa de criptografia (usado no diagnóstico)
async function sendEmptyPush(sub, vapid) {
  return fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: await vapidAuth(sub.endpoint, vapid) } });
}

async function sendPush(sub, payload, vapid) {
  const ua = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), ua, ephPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Authorization: await vapidAuth(sub.endpoint, vapid) },
    body: concat(head, ephPub, ct)
  });
}

// Registra a resposta do serviço de push (Apple, Google, Mozilla) para diagnóstico
async function logResult(env, kind, endpoint, res) {
  const body = (await res.text()).slice(0, 300);
  const result = { kind, host: new URL(endpoint).host, status: res.status, body, at: new Date().toISOString() };
  console.log(JSON.stringify({ push: result }));
  try { await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind('last_' + kind, JSON.stringify(result)).run(); } catch {}
  return result;
}

function cleanPayload(b) {
  return { title: String(b.title || 'Hora da próxima?').slice(0, 80), body: String(b.body || '').slice(0, 220), token: String(b.token || '').slice(0, 20), tag: String(b.tag || 'bafometro-lembrete').slice(0, 40) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    try {
      await init(env);
      if (path === '/vapid') return json({ publicKey: (await getVapid(env, true)).pub });
      if (path === '/last') {
        const { results } = await env.DB.prepare("SELECT k, v FROM settings WHERE k LIKE 'last_%'").all();
        return json(Object.fromEntries(results.map(r => [r.k, JSON.parse(r.v)])));
      }
      if (req.method !== 'POST') return json({ ok: true, service: 'bafometro-push' });

      const b = await req.json();
      const sub = b.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'assinatura inválida' }, 400);
      const cleanSub = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };

      if (path === '/test') {
        // Envia 2 pushes depois de alguns segundos: um criptografado e um vazio (sem criptografia)
        const vapid = await getVapid(env, true);
        const delay = Math.min(Math.max(Number(b.delay) || 0, 0), 20) * 1000;
        ctx.waitUntil((async () => {
          await sleep(delay);
          try { await logResult(env, 'test', cleanSub.endpoint, await sendPush(cleanSub, cleanPayload({ title: 'Teste 1/2: criptografado', body: 'Se você está lendo isto, a criptografia funciona.', tag: 'teste-cripto' }), vapid)); }
          catch (e) { console.log(JSON.stringify({ pushError: String((e && e.message) || e) })); }
          await sleep(3000);
          try { await logResult(env, 'test_empty', cleanSub.endpoint, await sendEmptyPush(cleanSub, vapid)); }
          catch (e) { console.log(JSON.stringify({ pushError: String((e && e.message) || e) })); }
        })());
        return json({ scheduled: true, delay: delay / 1000 });
      }
      const kind = b.kind === 'water' ? 'water' : 'next';
      if (path === '/schedule') {
        const at = Number(b.at);
        if (!Number.isFinite(at)) return json({ error: 'horário inválido' }, 400);
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reminders2').first()).n;
        if (n >= MAX_ENTRIES) return json({ error: 'limite atingido' }, 429);
        await env.DB.prepare('INSERT INTO reminders2 (endpoint, kind, sub, at, payload) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(endpoint, kind) DO UPDATE SET sub = ?3, at = ?4, payload = ?5')
          .bind(cleanSub.endpoint, kind, JSON.stringify(cleanSub), Math.round(at), JSON.stringify(cleanPayload(b))).run();
        return json({ ok: true });
      }
      if (path === '/cancel') {
        if (b.kind) await env.DB.prepare('DELETE FROM reminders2 WHERE endpoint = ? AND kind = ?').bind(cleanSub.endpoint, kind).run();
        else await env.DB.prepare('DELETE FROM reminders2 WHERE endpoint = ?').bind(cleanSub.endpoint).run();
        return json({ ok: true });
      }
      return json({ error: 'rota desconhecida' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // Roda a cada minuto: envia os lembretes vencidos
  async scheduled(event, env, ctx) {
    await init(env);
    const vapid = await getVapid(env, false);
    if (!vapid) return;
    const now = Date.now();
    const { results } = await env.DB.prepare('SELECT endpoint, kind, sub, at, payload FROM reminders2 WHERE at <= ?').bind(now).all();
    for (const r of results) {
      // apaga primeiro: só envia quem conseguiu "reservar" o lembrete (evita envio duplicado)
      const del = await env.DB.prepare('DELETE FROM reminders2 WHERE endpoint = ? AND kind = ? AND at = ?').bind(r.endpoint, r.kind, r.at).run();
      if (!del.meta.changes || now - r.at > 30 * 60e3) continue;
      try { await logResult(env, r.kind === 'water' ? 'agua' : 'lembrete', r.endpoint, await sendPush(JSON.parse(r.sub), JSON.parse(r.payload), vapid)); }
      catch (e) { console.log(JSON.stringify({ pushError: String((e && e.message) || e) })); }
    }
  }
};
