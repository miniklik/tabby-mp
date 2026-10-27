var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var MAX_OBJS = 300;
var MAX_OBJ = 15e5;
var MAX_PODPIS = 1e5;
// 🌍 gry udostępnione kodem: plansza (dane) do 4 MB, w kawałkach po 1 MB; nowe gry — limit na godzinę z jednego adresu
var MAX_GRA = 4e6;
var GRA_CH = 1e6;
var GRA_LIM = 20;
var GRA_ABC = "BCDFGHJKLMNPQRSTVWXZ23456789"; // bez samogłosek (żadnych słów w kodzie) i bez 0/O, 1/I
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha, "sha");
var Room = class {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.q = Promise.resolve();
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const n = this.ctx.getWebSockets().length;
      server.send(JSON.stringify({ t: "_n", n }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const P = new URL(request.url).pathname, L = P.startsWith("/licznik/"), SC = P.startsWith("/sciana/"), G = P.startsWith("/gra/"), LM = P.startsWith("/lim/");
    const run = this.q.then(() => L ? this.licznik(request) : SC ? this.sciana(request) : G ? this.gra(request) : LM ? this.lim(request) : this.store(request));
    this.q = run.catch(() => {
    });
    return run;
  }
  webSocketMessage(ws, message) {
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(message);
        } catch (e) {
        }
      }
    }
  }
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch (e) {
    }
  }
  webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch (e) {
    }
  }
  // ---------- licznik odwiedzin Alicji: POST = nowa osoba (+1), GET = tylko odczyt ----------
  async licznik(request) {
    const S = this.ctx.storage;
    let n = await S.get("n") || 0;
    if (request.method === "POST") {
      n++;
      await S.put("n", n);
    }
    return J({ ok: 1, n });
  }
  // ---------- ściana z podpisami (bawialnia w przejściu Alicji): GET ?od=N = podpisy po N, POST add = nowy podpis (każdy może), POST del = zmazuje woźny (klucz) ----------
  async sciana(request) {
    const S = this.ctx.storage, url = new URL(request.url), pad = (n) => String(n).padStart(9, "0");
    if (request.method === "GET") {
      const od = Math.max(0, parseInt(url.searchParams.get("od") || "0", 10) || 0);
      const m = await S.list({ prefix: "p:", start: "p:" + pad(od + 1), limit: 300 });
      const p = [];
      for (const [k, v] of m) p.push({ i: +k.slice(2), d: v.d, t: v.t, n: v.n || "" });
      return J({ ok: 1, n: await S.get("n") || 0, p, more: p.length >= 300 ? 1 : 0 });
    }
    if (request.method !== "POST") return J({ ok: 0, err: "metoda" }, 405);
    let b;
    try {
      b = JSON.parse(await request.text());
    } catch (e) {
      return J({ ok: 0, err: "z\u0142y JSON" }, 400);
    }
    if (b && b.op === "add") {
      if (typeof b.d !== "string" || b.d.length < 5 || b.d.length > MAX_PODPIS) return J({ ok: 0, err: "podpis za du\u017Cy" }, 413);
      const n = (await S.get("n") || 0) + 1;
      await S.put("p:" + pad(n), { d: b.d, t: Date.now(), n: String(b.n || "").slice(0, 24) });
      await S.put("n", n);
      return J({ ok: 1, i: n });
    }
    if (!b || typeof b.k !== "string" || b.k.length < 16 || b.k.length > 80) return J({ ok: 0, err: "brak klucza" }, 400);
    const h = await sha(b.k), w = await S.get("h");
    if (b.op === "claim") {
      if (!w) {
        await S.put("h", h);
        return J({ ok: 1, created: 1 });
      }
      return J(w === h ? { ok: 1 } : { ok: 0, taken: 1 });
    }
    if (!w || w !== h) return J({ ok: 0, err: "z\u0142y klucz" }, 403);
    if (b.op === "del") {
      const i = parseInt(b.i, 10) || 0;
      await S.delete("p:" + pad(i));
      return J({ ok: 1 });
    }
    return J({ ok: 0, err: "nieznana operacja" }, 400);
  }
  // ---------- 🌍 limit nowych gier z jednego adresu (na godzinę) ----------
  async lim(request) {
    const S = this.ctx.storage, hr = Math.floor(Date.now() / 36e5);
    let o = await S.get("o") || { hr, n: 0 };
    if (o.hr !== hr) o = { hr, n: 0 };
    if (o.n >= GRA_LIM) return J({ ok: 0 });
    o.n++;
    await S.put("o", o);
    return J({ ok: 1 });
  }
  // ---------- 🌍 gra udostępniona kodem: GET = zagraj (?meta=1 tylko nazwa i autor), POST new/put/del = autor (klucz) ----------
  async gra(request) {
    const S = this.ctx.storage, url = new URL(request.url);
    const meta = await S.get("meta");
    if (request.method === "GET") {
      if (!meta) return J({ ok: 0, none: 1 });
      const inf = { ok: 1, n: meta.n, a: meta.a, m: meta.m, t: meta.t, upd: meta.upd, g: meta.g || 0 };
      if (url.searchParams.get("meta")) return J(inf);
      let d = "";
      for (let i = 0; i < meta.parts; i++) d += await S.get("c:" + i) || "";
      if (url.searchParams.get("play")) {
        meta.g = (meta.g || 0) + 1;
        await S.put("meta", meta);
        inf.g = meta.g;
      }
      inf.d = d;
      return J(inf);
    }
    if (request.method !== "POST") return J({ ok: 0, err: "metoda" }, 405);
    let b;
    try {
      b = JSON.parse(await request.text());
    } catch (e) {
      return J({ ok: 0, err: "z\u0142y JSON" }, 400);
    }
    if (!b || typeof b.k !== "string" || b.k.length < 16 || b.k.length > 80) return J({ ok: 0, err: "brak klucza" }, 400);
    const h = await sha(b.k);
    if (b.op === "new" && meta) return J({ ok: 0, taken: 1 });
    if (b.op !== "new" && (!meta || meta.h !== h)) return J({ ok: 0, err: meta ? "z\u0142y klucz" : "nie ma takiej gry" }, meta ? 403 : 404);
    if (b.op === "del") {
      await S.deleteAll();
      return J({ ok: 1 });
    }
    if (b.op !== "new" && b.op !== "put") return J({ ok: 0, err: "nieznana operacja" }, 400);
    if (typeof b.d !== "string" || b.d.length < 10 || b.d.length > MAX_GRA) return J({ ok: 0, err: "gra za du\u017Ca" }, 413);
    const parts = Math.ceil(b.d.length / GRA_CH), old = meta ? meta.parts : 0;
    for (let i = 0; i < parts; i++) await S.put("c:" + i, b.d.slice(i * GRA_CH, (i + 1) * GRA_CH));
    for (let i = parts; i < old; i++) await S.delete("c:" + i);
    const m = { h, n: String(b.n || "").slice(0, 40) || "Gra", a: String(b.a || "").slice(0, 30), m: b.m === "razem" ? "razem" : "sam", t: meta ? meta.t : Date.now(), upd: Date.now(), parts, g: meta ? meta.g || 0 : 0 };
    await S.put("meta", m);
    return J({ ok: 1 });
  }
  // ---------- pamięć pokoju ----------
  async store(request) {
    const S = this.ctx.storage, url = new URL(request.url);
    const meta = await S.get("meta");
    if (request.method === "GET") {
      if (!meta) return J({ ok: 0, none: 1 });
      if (url.searchParams.get("meta")) return J({ ok: 1, owner: meta.owner, ids: meta.ids, upd: meta.upd, tot: meta.tot || 0 });
      const objs = [];
      for (const it of meta.ids) {
        const d = await S.get("o:" + it.id);
        if (d) objs.push({ id: it.id, t: it.t, d, dl: it.dl || 0 });
      }
      return J({ ok: 1, owner: meta.owner, objs, upd: meta.upd, tot: meta.tot || 0 });
    }
    if (request.method !== "POST") return J({ ok: 0, err: "metoda" }, 405);
    let b;
    try {
      b = JSON.parse(await request.text());
    } catch (e) {
      return J({ ok: 0, err: "z\u0142y JSON" }, 400);
    }
    if (b && b.op === "dl") {
      const id2 = String(b.id || ""), u = String(b.u || "");
      if (!meta || !/^[A-Za-z0-9_-]{8,40}$/.test(u)) return J({ ok: 0, err: "brak" }, 400);
      const it = meta.ids.find((x) => x.id === id2);
      if (!it) return J({ ok: 0, err: "nie ma obiektu" }, 404);
      const who = await S.get("d:" + id2) || [];
      if (who.indexOf(u) >= 0) return J({ ok: 1, dl: it.dl || 0, tot: meta.tot || 0, counted: 0 });
      if (who.length < 2e4) {
        who.push(u);
        await S.put("d:" + id2, who);
      }
      it.dl = (it.dl || 0) + 1;
      meta.tot = (meta.tot || 0) + 1;
      await S.put("meta", meta);
      return J({ ok: 1, dl: it.dl, tot: meta.tot, counted: 1 });
    }
    if (!b || typeof b.k !== "string" || b.k.length < 16 || b.k.length > 80) return J({ ok: 0, err: "brak klucza" }, 400);
    const h = await sha(b.k), owner = String(b.owner || "").slice(0, 24);
    if (b.op === "claim") {
      if (!meta) {
        await S.put("meta", { h, owner, ids: [], upd: Date.now() });
        return J({ ok: 1, created: 1 });
      }
      return J(meta.h === h ? { ok: 1 } : { ok: 0, taken: 1 });
    }
    if (!meta || meta.h !== h) return J({ ok: 0, err: "z\u0142y klucz" }, 403);
    if (b.op === "auth") return J({ ok: 1 });
    if (b.op === "owner") {
      meta.owner = owner;
      await S.put("meta", meta);
      return J({ ok: 1 });
    }
    const id = String(b.id || "").slice(0, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return J({ ok: 0, err: "z\u0142y id" }, 400);
    if (b.op === "put") {
      if (typeof b.d !== "string" || b.d.length > MAX_OBJ) return J({ ok: 0, err: "obiekt za du\u017Cy" }, 413);
      const i = meta.ids.findIndex((x) => x.id === id), it = { id, t: +b.t || Date.now(), n: String(b.n || "").slice(0, 40), dl: i >= 0 ? meta.ids[i].dl || 0 : 0 };
      if (i < 0 && meta.ids.length >= MAX_OBJS) return J({ ok: 0, err: "pok\xF3j pe\u0142ny" }, 409);
      if (i < 0) meta.ids.push(it);
      else meta.ids[i] = it;
      meta.upd = Date.now();
      await S.put("o:" + id, b.d);
      await S.put("meta", meta);
      return J({ ok: 1 });
    }
    if (b.op === "del") {
      meta.ids = meta.ids.filter((x) => x.id !== id);
      meta.upd = Date.now();
      await S.delete("o:" + id);
      await S.delete("d:" + id);
      await S.put("meta", meta);
      return J({ ok: 1 });
    }
    return J({ ok: 0, err: "nieznana operacja" }, 400);
  }
};
var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
function J(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}
__name(J, "J");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const txt = { ...CORS, "Content-Type": "text/plain; charset=utf-8" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/ping") return new Response("Tabby MP OK", { headers: txt });
    if (url.pathname === "/gra" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "x";
      const lr = await (await env.ROOMS.get(env.ROOMS.idFromName("lim:" + ip)).fetch(new Request(url.origin + "/lim/", { method: "POST" }))).json();
      if (!lr.ok) return J({ ok: 0, err: "Za du\u017Co nowych gier \u2014 spr\xF3buj za godzin\u0119" }, 429);
      const body = await request.text();
      if (body.length > MAX_GRA + 2e4) return J({ ok: 0, err: "gra za du\u017Ca" }, 413);
      let b;
      try {
        b = JSON.parse(body);
      } catch (e) {
        return J({ ok: 0, err: "z\u0142y JSON" }, 400);
      }
      b.op = "new";
      const nb = JSON.stringify(b);
      for (let t = 0; t < 8; t++) {
        let kod = "";
        const r = crypto.getRandomValues(new Uint8Array(6));
        for (let i = 0; i < 6; i++) kod += GRA_ABC[r[i] % GRA_ABC.length];
        const res = await env.ROOMS.get(env.ROOMS.idFromName("gra:" + kod)).fetch(new Request(url.origin + "/gra/" + kod, { method: "POST", body: nb }));
        const o = await res.json();
        if (o.taken) continue;
        if (o.ok) o.kod = kod;
        return J(o, res.status);
      }
      return J({ ok: 0, err: "spr\xF3buj jeszcze raz" }, 503);
    }
    const gm = url.pathname.match(/^\/gra\/([A-Z0-9]{6})$/);
    if (gm) {
      const st = env.ROOMS.get(env.ROOMS.idFromName("gra:" + gm[1]));
      if (request.method !== "POST") return st.fetch(request);
      const body = await request.text();
      if (body.length > MAX_GRA + 2e4) return J({ ok: 0, err: "gra za du\u017Ca" }, 413);
      if (/"op"\s*:\s*"new"/.test(body)) return J({ ok: 0, err: "nowa gra tylko przez /gra" }, 400);
      return st.fetch(new Request(request.url, { method: "POST", body }));
    }
    if (url.pathname === "/licznik/alicja") return env.ROOMS.get(env.ROOMS.idFromName("licznik:alicja")).fetch(request);
    const sc = url.pathname.match(/^\/sciana\/([a-z0-9-]{1,40})$/);
    if (sc) return env.ROOMS.get(env.ROOMS.idFromName("sciana:" + sc[1])).fetch(request);
    const s = url.pathname.match(/^\/store\/([A-Z0-9]{4,8})$/);
    if (s) return env.ROOMS.get(env.ROOMS.idFromName("store:" + s[1])).fetch(request);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,80})$/);
    if (!m) return new Response("Nie ma takiej strony", { status: 404, headers: txt });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Tu \u0142\u0105czy si\u0119 gra (WebSocket)", { status: 426, headers: txt });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  }
};
export {
  Room,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
