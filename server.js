'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const PORT = Number(process.env.PORT) || 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
/* Overridable so a test run can't clobber the cert the real server uses --
 * they see different local IPs and would regenerate over each other. */
const CERT_DIR = path.resolve(__dirname, process.env.CERT_DIR || '.cert');

/* ------------------------------------------------------------------ *
 * Channel code -- on a LAN the network was the access control. Once
 * the server is reachable from the internet it isn't, so joining takes
 * a code. Set PTT_CODE to keep it stable across restarts.
 * ------------------------------------------------------------------ */

const MAX_PEERS = Number(process.env.MAX_PEERS) || 12;
const JOIN_GRACE_MS = 10000;

function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
  return [...crypto.randomBytes(6)]
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

const CODE = String(process.env.PTT_CODE || generateCode()).trim().toUpperCase();

/* ------------------------------------------------------------------ *
 * Local addresses
 * ------------------------------------------------------------------ */

function localIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * TLS -- getUserMedia() only works on a secure origin, so plain http
 * over a LAN IP will not give us the microphone. We generate a
 * long-lived self-signed cert that covers localhost + every LAN IP.
 * ------------------------------------------------------------------ */

function loadOrCreateCert(ips) {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const metaPath = path.join(CERT_DIR, 'ips.json');

  const sameIPs = () => {
    try {
      const prev = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return JSON.stringify(prev.sort()) === JSON.stringify([...ips].sort());
    } catch {
      return false;
    }
  };

  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && sameIPs()) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: 'lan-ptt' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, JSON.stringify(ips));
  console.log(`Generated a new self-signed certificate in ${CERT_DIR}`);
  return { key: pems.private, cert: pems.cert };
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * Channel state
 * ------------------------------------------------------------------ */

/** id -> { id, name, ws, target, talking, sampleRate } */
const peers = new Map();
let nextId = 1;

/** Only one person holds the floor at a time, like a real radio. */
let floorHolder = null;

const roster = () =>
  [...peers.values()].map((p) => ({ id: p.id, name: p.name }));

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, exceptId = null) {
  for (const p of peers.values()) {
    if (p.id !== exceptId) send(p.ws, obj);
  }
}

/** Who should hear this speaker: everyone else, or one specific peer. */
function listenersFor(speaker) {
  if (speaker.target === 'all') {
    return [...peers.values()].filter((p) => p.id !== speaker.id);
  }
  const one = peers.get(speaker.target);
  return one ? [one] : [];
}

function releaseFloor(peer, reason) {
  if (floorHolder !== peer.id) return;
  floorHolder = null;
  peer.talking = false;
  broadcast({ type: 'talk-end', from: peer.id, reason }, peer.id);
}

/* ------------------------------------------------------------------ *
 * Wire up
 * ------------------------------------------------------------------ */

const ips = localIPv4s();

/* Tunnel mode serves plain HTTP: Cloudflare terminates TLS with a real
 * certificate, so the origin must not also be TLS. */
const TUNNEL = process.argv.includes('--tunnel') || process.env.TUNNEL === '1';
const useTLS = !TUNNEL && process.env.NO_TLS !== '1';
const server = useTLS
  ? https.createServer(loadOrCreateCert(ips), serveStatic)
  : http.createServer(serveStatic);

const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });

wss.on('connection', (ws) => {
  const peer = {
    id: nextId++,
    name: null,
    ws,
    target: 'all',
    talking: false,
    sampleRate: 16000,
    alive: true,
  };

  ws.binaryType = 'nodebuffer';
  ws.on('pong', () => {
    peer.alive = true;
  });

  /* The heartbeat only walks joined peers, so a socket that never sends
   * `join` would otherwise sit here forever. On a public URL that is a
   * free way to pile up sockets. Give it a few seconds, then drop it. */
  const joinTimer = setTimeout(() => {
    if (!peers.has(peer.id)) {
      send(ws, { type: 'denied', reason: 'timeout' });
      ws.close();
    }
  }, JOIN_GRACE_MS);

  ws.on('message', (data, isBinary) => {
    /* ---- audio ---- */
    if (isBinary) {
      if (!peer.talking || floorHolder !== peer.id) return;

      // Prepend the speaker id so receivers can mix per-sender.
      const header = Buffer.alloc(4);
      header.writeUInt32BE(peer.id, 0);
      const frame = Buffer.concat([header, data]);

      for (const l of listenersFor(peer)) {
        if (l.ws.readyState === l.ws.OPEN) l.ws.send(frame, { binary: true });
      }
      return;
    }

    /* ---- control ---- */
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        if (peers.has(peer.id)) return;

        if (String(msg.code || '').trim().toUpperCase() !== CODE) {
          send(ws, { type: 'denied', reason: 'code' });
          ws.close();
          return;
        }
        if (peers.size >= MAX_PEERS) {
          send(ws, { type: 'denied', reason: 'full' });
          ws.close();
          return;
        }
        clearTimeout(joinTimer);

        const clean = String(msg.name || '').trim().slice(0, 24);
        peer.name = clean || `Radio ${peer.id}`;
        peers.set(peer.id, peer);
        send(ws, { type: 'welcome', id: peer.id, name: peer.name, peers: roster() });
        broadcast(
          { type: 'peer-join', peer: { id: peer.id, name: peer.name } },
          peer.id
        );
        console.log(`+ ${peer.name} (#${peer.id}) — ${peers.size} on channel`);
        break;
      }

      case 'talk-start': {
        if (!peers.has(peer.id)) return;

        if (floorHolder !== null && floorHolder !== peer.id) {
          const holder = peers.get(floorHolder);
          send(ws, { type: 'busy', by: holder ? holder.name : 'someone' });
          return;
        }

        floorHolder = peer.id;
        peer.talking = true;
        peer.target = msg.to === 'all' ? 'all' : Number(msg.to);
        peer.sampleRate = Number(msg.sampleRate) || 16000;

        const note = {
          type: 'talk-start',
          from: peer.id,
          fromName: peer.name,
          direct: peer.target !== 'all',
          sampleRate: peer.sampleRate,
        };
        for (const l of listenersFor(peer)) send(l.ws, note);
        send(ws, { type: 'floor-granted' });
        break;
      }

      case 'talk-end':
        releaseFloor(peer, 'released');
        break;

      case 'rename': {
        const clean = String(msg.name || '').trim().slice(0, 24);
        if (!clean || !peers.has(peer.id)) return;
        peer.name = clean;
        broadcast({ type: 'peer-rename', id: peer.id, name: peer.name });
        break;
      }
    }
  });

  const drop = () => {
    clearTimeout(joinTimer);
    releaseFloor(peer, 'disconnected');
    if (peers.delete(peer.id)) {
      broadcast({ type: 'peer-leave', id: peer.id });
      console.log(`- ${peer.name} (#${peer.id}) — ${peers.size} on channel`);
    }
  };

  ws.on('close', drop);
  ws.on('error', drop);
});

/* Drop peers whose Wi-Fi vanished without a clean close. */
const heartbeat = setInterval(() => {
  for (const p of peers.values()) {
    if (!p.alive) {
      p.ws.terminate();
      continue;
    }
    p.alive = false;
    try {
      p.ws.ping();
    } catch {
      /* terminated next tick */
    }
  }
}, 5000);

wss.on('close', () => clearInterval(heartbeat));

/* ------------------------------------------------------------------ *
 * Cloudflare tunnel -- one public https URL, reachable from any network,
 * with a certificate browsers already trust. Outbound only, so there is
 * no port to forward and no inbound firewall rule to add.
 * ------------------------------------------------------------------ */

function startTunnel(port) {
  const bin = process.env.CLOUDFLARED || 'cloudflared';
  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // lets PATH resolve cloudflared.exe
  });

  let url = null;
  const scan = (chunk) => {
    if (url) return;
    const found = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!found) return;
    url = found[0];
    console.log(`  Public URL: ${url}`);
    console.log('  Works from any network. Send it with the channel code.\n');
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('error', (err) => {
    console.log(
      err.code === 'ENOENT'
        ? '  Tunnel skipped: cloudflared is not on PATH.'
        : `  Tunnel skipped: ${err.message}`
    );
    console.log('  Still serving locally -- see the addresses above.\n');
  });

  child.on('exit', (code) => {
    if (code !== 0 && !url) {
      console.log(`  Tunnel exited before publishing a URL (code ${code}).\n`);
    }
  });

  /* Leave cloudflared running and the public hostname stays alive after the
   * channel is gone -- and a later restart quietly re-serves that stale URL.
   * On Windows `shell:true` puts a cmd.exe between us and cloudflared, so a
   * plain kill() only removes the wrapper; take down the whole tree. */
  let stopped = false;
  const stop = () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        child.kill();
      }
    } catch {
      /* already gone */
    }
  };

  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }

  setTimeout(() => {
    if (!url) console.log('  Tunnel is still negotiating a URL...');
  }, 15000);
}

server.listen(PORT, '0.0.0.0', () => {
  const scheme = useTLS ? 'https' : 'http';

  if (TUNNEL) {
    console.log('\n  LAN PTT is up, publishing a tunnel.\n');
    console.log(`    ${scheme}://localhost:${PORT}   (this machine only)`);
  } else {
    console.log('\n  LAN PTT is up. Open one of these on every phone:\n');
    console.log(`    ${scheme}://localhost:${PORT}`);
    for (const ip of ips) console.log(`    ${scheme}://${ip}:${PORT}`);
  }

  if (useTLS) {
    console.log(
      '\n  The certificate is self-signed, so each device will warn once.'
    );
    console.log('  Tap Advanced -> Proceed. The microphone needs https.');
  }

  console.log(`\n  Channel code: ${CODE}`);
  console.log('  Everyone needs it to join. Set PTT_CODE to pin it.\n');

  if (TUNNEL) startTunnel(PORT);
});
