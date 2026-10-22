import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export function attachRealtime(server, origin, secret) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map();
  const send = (ws, event, data, channel) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data: typeof data === 'string' ? data : JSON.stringify(data), ...(channel ? { channel } : {}) }));
  };
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, origin); } catch { socket.destroy(); return; }
    const originHeader = request.headers.origin;
    if (originHeader && originHeader !== 'null' && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(originHeader)) { socket.destroy(); return; }
    if (!url.pathname.startsWith('/app/')) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', ws => {
    const id = `${crypto.randomInt(100000,999999)}.${crypto.randomInt(100000,999999)}`;
    clients.set(ws, { id, channels: new Set() });
    send(ws, 'pusher:connection_established', { socket_id: id, activity_timeout: 120 });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send(ws, 'pusher:error', { code: 4200, message: 'JSON invalide' }); return; }
      if (message.event === 'pusher:ping') { send(ws, 'pusher:pong', {}); return; }
      if (message.event === 'pusher:subscribe') {
        let data = message.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
        const channel = String(data?.channel || '');
        if (!channel || channel.length > 200) return;
        if (channel.startsWith('private-')) {
          const expected='local-test:'+crypto.createHmac('sha256',secret).update(`${id}:${channel}`).digest('hex');
          const supplied=Buffer.from(String(data.auth||'')),wanted=Buffer.from(expected);
          if(supplied.length!==wanted.length||!crypto.timingSafeEqual(supplied,wanted)) { send(ws, 'pusher:error', { code: 4009, message: 'Autorisation locale requise' }); return; }
        }
        clients.get(ws)?.channels.add(channel);
        send(ws, 'pusher_internal:subscription_succeeded', {}, channel);
      } else if (message.event === 'pusher:unsubscribe') clients.get(ws)?.channels.delete(message.data?.channel);
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {});
  });
  function emit(userId, event, payload) {
    const channels = [];
    if (userId !== null && userId !== undefined) channels.push(`private-App.Models.Login.User.${userId}`);
    if (/^Offer(?:Created|Updated|Deleted)$/.test(event)) {
      const offer = Array.isArray(payload) ? payload[0] : payload;
      channels.push(`offers_${offer?.server_id ?? 5}`);
    }
    if (/Draft/.test(event)) {
      const data = Array.isArray(payload) ? payload[0] : payload;
      channels.push(`draft.${data?.id ?? data?.draft_id ?? 1}`, `draft_${data?.id ?? 1}`);
    }
    for (const [ws, client] of clients) {
      for (const channel of channels.filter(x => client.channels.has(x))) {
        send(ws, event.includes('\\') || event.startsWith('.') ? event.replace(/^\./, '') : `App\\Events\\${event}`, payload, channel);
      }
    }
  }
  return { emit, close: () => {for(const client of clients.keys())client.terminate();wss.close();}, stats: () => ({ connections: clients.size, channels: [...new Set([...clients.values()].flatMap(x => [...x.channels]))] }) };
}
