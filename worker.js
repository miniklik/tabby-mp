// Tabby MP — własna centrala multiplayer (Cloudflare Worker + Durable Objects)
// 1) /room/<nazwa>  — WebSocket: centrala przekazuje wiadomości między graczami w tym samym pokoju (gry i Tabby-pokój).
//    Po połączeniu gracz dostaje {t:'_n', n:<ilu jest w pokoju razem z nim>} — z tego gra wie, czy pokój istnieje.
// 2) /store/<KOD>   — pamięć Tabby-pokoju: obiekty (teksty JSON) zostają w chmurze także wtedy, gdy właściciela nie ma.
//    GET  /store/KOD         → wszystkie obiekty pokoju (czytać może każdy)
//    GET  /store/KOD?meta=1  → tylko lista (do znaczka „nowe” u znajomych)
//    POST /store/KOD         → zmiany — tylko właściciel z tajnym kluczem: claim / put / del / owner / auth

const MAX_OBJS = 300, MAX_OBJ = 1500000;

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.q = Promise.resolve(); }
  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const n = this.ctx.getWebSockets().length;
      server.send(JSON.stringify({ t: '_n', n }));
      return new Response(null, { status: 101, webSocket: client });
    }
    // zmiany w pamięci jedna po drugiej — dwa zapisy naraz nie nadpiszą sobie listy obiektów
    const run = this.q.then(() => this.store(request));
    this.q = run.catch(() => {});
    return run;
  }
  webSocketMessage(ws, message) {
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(message); } catch (e) {} }
    }
  }
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch (e) {} }
  webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) {} }

  // ---------- pamięć pokoju ----------
  async store(request) {
    const S = this.ctx.storage, url = new URL(request.url);
    const meta = await S.get('meta');
    if (request.method === 'GET') {
      if (!meta) return J({ ok: 0, none: 1 });
      if (url.searchParams.get('meta')) return J({ ok: 1, owner: meta.owner, ids: meta.ids, upd: meta.upd });
      const objs = [];
      for (const it of meta.ids) { const d = await S.get('o:' + it.id); if (d) objs.push({ id: it.id, t: it.t, d }); }
      return J({ ok: 1, owner: meta.owner, objs, upd: meta.upd });
    }
    if (request.method !== 'POST') return J({ ok: 0, err: 'metoda' }, 405);
    let b; try { b = JSON.parse(await request.text()); } catch (e) { return J({ ok: 0, err: 'zły JSON' }, 400); }
    if (!b || typeof b.k !== 'string' || b.k.length < 16 || b.k.length > 80) return J({ ok: 0, err: 'brak klucza' }, 400);
    const h = await sha(b.k), owner = String(b.owner || '').slice(0, 24);
    if (b.op === 'claim') {
      if (!meta) { await S.put('meta', { h, owner, ids: [], upd: Date.now() }); return J({ ok: 1, created: 1 }); }
      return J(meta.h === h ? { ok: 1 } : { ok: 0, taken: 1 });
    }
    if (!meta || meta.h !== h) return J({ ok: 0, err: 'zły klucz' }, 403);
    if (b.op === 'auth') return J({ ok: 1 });
    if (b.op === 'owner') { meta.owner = owner; await S.put('meta', meta); return J({ ok: 1 }); }
    const id = String(b.id || '').slice(0, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return J({ ok: 0, err: 'zły id' }, 400);
    if (b.op === 'put') {
      if (typeof b.d !== 'string' || b.d.length > MAX_OBJ) return J({ ok: 0, err: 'obiekt za duży' }, 413);
      const i = meta.ids.findIndex(x => x.id === id), it = { id, t: +b.t || Date.now(), n: String(b.n || '').slice(0, 40) };
      if (i < 0 && meta.ids.length >= MAX_OBJS) return J({ ok: 0, err: 'pokój pełny' }, 409);
      if (i < 0) meta.ids.push(it); else meta.ids[i] = it;
      meta.upd = Date.now(); await S.put('o:' + id, b.d); await S.put('meta', meta); return J({ ok: 1 });
    }
    if (b.op === 'del') {
      meta.ids = meta.ids.filter(x => x.id !== id); meta.upd = Date.now();
      await S.delete('o:' + id); await S.put('meta', meta); return J({ ok: 1 });
    }
    return J({ ok: 0, err: 'nieznana operacja' }, 400);
  }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function J(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const txt = { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/ping') return new Response('Tabby MP OK', { headers: txt });
    const s = url.pathname.match(/^\/store\/([A-Z0-9]{4,8})$/);
    if (s) return env.ROOMS.get(env.ROOMS.idFromName('store:' + s[1])).fetch(request);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,80})$/);
    if (!m) return new Response('Nie ma takiej strony', { status: 404, headers: txt });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Tu łączy się gra (WebSocket)', { status: 426, headers: txt });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  }
};
