// Tabby MP — własna centrala multiplayer (Cloudflare Worker + Durable Objects)
// Każdy pokój gry to osobny „Room”. Centrala przekazuje wiadomości między graczami w tym samym pokoju.
// Po połączeniu gracz dostaje {t:'_n', n:<ilu jest w pokoju razem z nim>} — z tego gra wie, czy pokój istnieje.

export class Room {
  constructor(ctx, env) { this.ctx = ctx; }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const n = this.ctx.getWebSockets().length;
    server.send(JSON.stringify({ t: '_n', n }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, message) {
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(message); } catch (e) {} }
    }
  }
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch (e) {} }
  webSocketError(ws) { try { ws.close(1011, 'error'); } catch (e) {} }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' };
    if (url.pathname === '/' || url.pathname === '/ping') return new Response('Tabby MP OK', { headers: cors });
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,80})$/);
    if (!m) return new Response('Nie ma takiej strony', { status: 404, headers: cors });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Tu łączy się gra (WebSocket)', { status: 426, headers: cors });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  }
};
