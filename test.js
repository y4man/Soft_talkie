// Boots the real server and drives it with three fake handsets.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const https = require('https');

const PORT = 9443;
const CODE = 'TESTCODE';
const URL = `wss://127.0.0.1:${PORT}`;
const OPT = { rejectUnauthorized: false };

const log = [];
const ok = (label, pass) => {
  log.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
};

const srv = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(PORT),
    PTT_CODE: CODE,
    CERT_DIR: '.cert-test',
  },
});
let boot = '';
srv.stdout.on('data', (d) => (boot += d));
srv.stderr.on('data', (d) => console.error('SERVER:', d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function handset(name, code = CODE) {
  const ws = new WebSocket(URL, OPT);
  ws.binaryType = 'nodebuffer';
  const h = { ws, name, ctrl: [], audio: [], id: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      h.audio.push({ from: data.readUInt32BE(0), bytes: data.length - 4 });
    } else {
      const m = JSON.parse(data.toString());
      if (m.type === 'welcome') h.id = m.id;
      h.ctrl.push(m);
    }
  });
  h.ready = new Promise((res) => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', name, code }));
    res();
  }));
  h.seen = (t) => h.ctrl.filter((m) => m.type === t);
  return h;
}

function pcm(n) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(((i * 977) % 4000) - 2000, i * 2);
  return b;
}

(async () => {
  /* Poll rather than sleep a fixed span: a cold .cert-test means the server
   * has to generate a 2048-bit key first, which easily outlasts any guess. */
  const booted = await waitForBoot();
  ok('server boots and prints reachable addresses',
    booted && /https:\/\/localhost:9443/.test(boot));
  ok('self-signed cert is served', booted);

  const a = handset('Ahmed');
  const b = handset('Bilal');
  await Promise.all([a.ready, b.ready]);
  await wait(200);

  const c = handset('Chand');
  await c.ready;
  await wait(250);

  // --- roster ---
  ok('joiner receives its own id', typeof a.id === 'number');
  const cw = c.ctrl.find((m) => m.type === 'welcome');
  ok('later joiner sees the whole channel, itself included',
    cw.peers.length === 3 && cw.peers.some((p) => p.id === cw.id));
  ok('existing peers are told about a new join',
    a.seen('peer-join').some((m) => m.peer.name === 'Chand'));

  // --- broadcast audio ---
  a.ws.send(JSON.stringify({ type: 'talk-start', to: 'all', sampleRate: 16000 }));
  await wait(120);
  ok('speaker is granted the floor', a.seen('floor-granted').length === 1);
  ok('everyone else is told who is talking',
    b.seen('talk-start')[0]?.fromName === 'Ahmed' &&
    c.seen('talk-start')[0]?.fromName === 'Ahmed');

  for (let i = 0; i < 5; i++) { a.ws.send(pcm(640)); await wait(35); }
  await wait(200);
  ok('broadcast audio reaches every other handset',
    b.audio.length === 5 && c.audio.length === 5);
  ok('frames are tagged with the sender id',
    b.audio.every((f) => f.from === a.id));
  ok('audio payload survives intact (1280 B per 40 ms frame)',
    b.audio.every((f) => f.bytes === 1280));
  ok('speaker does not hear itself', a.audio.length === 0);

  // --- floor contention ---
  b.ws.send(JSON.stringify({ type: 'talk-start', to: 'all', sampleRate: 16000 }));
  await wait(120);
  ok('second talker is refused while channel is held',
    b.seen('busy')[0]?.by === 'Ahmed');
  b.ws.send(pcm(640));
  await wait(150);
  ok('refused talker cannot inject audio', c.audio.length === 5);

  a.ws.send(JSON.stringify({ type: 'talk-end' }));
  await wait(150);
  ok('release is announced to the channel', b.seen('talk-end').length === 1);

  // --- direct call ---
  b.ws.send(JSON.stringify({ type: 'talk-start', to: c.id, sampleRate: 16000 }));
  await wait(120);
  b.ws.send(pcm(320));
  await wait(200);
  ok('direct call reaches only the chosen handset',
    c.audio.length === 6 && a.audio.length === 0);
  ok('direct call is flagged as direct',
    c.seen('talk-start')[1]?.direct === true);
  ok('uninvolved handset is not notified of a direct call',
    a.seen('talk-start').length === 0);
  b.ws.send(JSON.stringify({ type: 'talk-end' }));
  await wait(120);

  // --- disconnect mid-transmission ---
  c.ws.send(JSON.stringify({ type: 'talk-start', to: 'all', sampleRate: 16000 }));
  await wait(120);
  c.ws.terminate();
  await wait(300);
  ok('dropping mid-transmission frees the floor',
    a.seen('talk-end').some((m) => m.reason === 'disconnected'));
  ok('departure is broadcast', a.seen('peer-leave').some((m) => m.id === c.id));

  a.ws.send(JSON.stringify({ type: 'talk-start', to: 'all', sampleRate: 16000 }));
  await wait(150);
  ok('channel is usable again after the crash', a.seen('floor-granted').length === 2);

  // --- channel code ---
  const wrong = handset('Snoop', 'NOTTHECODE');
  await wrong.ready;
  await wait(250);
  ok('wrong code is denied', wrong.seen('denied').some((m) => m.reason === 'code'));
  ok('denied handset never reaches the roster',
    wrong.seen('welcome').length === 0 &&
    !a.seen('peer-join').some((m) => m.peer.name === 'Snoop'));
  ok('denied socket is closed by the server',
    wrong.ws.readyState === WebSocket.CLOSING ||
    wrong.ws.readyState === WebSocket.CLOSED);

  const blank = handset('Ghost', '');
  await blank.ready;
  await wait(250);
  ok('missing code is denied too', blank.seen('denied').some((m) => m.reason === 'code'));

  a.ws.close(); b.ws.close();
  await wait(200);
  srv.kill();

  const failed = log.filter((r) => !r.pass).length;
  console.log(`\n${log.length - failed}/${log.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });

async function waitForBoot(budgetMs = 45000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await probeTLS()) return true;
    await wait(150);
  }
  return false;
}

function probeTLS() {
  return new Promise((res) => {
    https.get({ host: '127.0.0.1', port: PORT, path: '/', rejectUnauthorized: false },
      (r) => { r.resume(); res(r.statusCode === 200); })
      .on('error', () => res(false));
  });
}
