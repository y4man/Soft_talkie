// Dev helper: puts fake handsets on the channel so you can test with one device.
//   node ghosts.js            -> three peers join and sit idle
//   TALK_AFTER=8000 node ghosts.js  -> one of them keys up after 8 s
const WebSocket = require('ws');
const PORT = process.env.PORT || 8443;
const TLS = process.env.NO_TLS === '1' ? 'ws' : 'wss';
const NAMES = (process.env.NAMES || 'Bilal,Sana,Usman').split(',');
const CODE = String(process.env.PTT_CODE || '').trim().toUpperCase();

const socks = NAMES.map((n) => {
  const ws = new WebSocket(`${TLS}://127.0.0.1:${PORT}`, { rejectUnauthorized: false });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', name: n.trim(), code: CODE }));
    console.log(`${n.trim()} joined`);
  });
  ws.on('error', (e) => console.error(n, e.message));
  return ws;
});

if (process.env.TALK_AFTER) {
  setTimeout(() => {
    console.log(`${NAMES[1]} keys up`);
    socks[1].send(JSON.stringify({ type: 'talk-start', to: 'all', sampleRate: 16000 }));
  }, Number(process.env.TALK_AFTER));
}

process.on('SIGINT', () => { socks.forEach((s) => s.close()); process.exit(0); });
