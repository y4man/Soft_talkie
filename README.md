# LAN PTT

Push-to-talk in the browser. Everyone who opens the page appears in a list; hold
the bar to talk to all of them, or tap one name to talk to just that person.

---

## Run it

```bash
npm install
npm start
```

`npm start` publishes a Cloudflare tunnel, so **anyone on any network can join**:

```
  Channel code: K7QP2M
  Public URL: https://random-words-here.trycloudflare.com
```

Send both. Everyone opens the URL, enters a name and the code, allows the
microphone, and holds the bar. Cloudflare supplies a real certificate, so there
is no security warning and the microphone just works.

Needs `cloudflared` on your PATH. Without it the server still runs locally and
says so.

### Same Wi-Fi only

```bash
npm run lan
```

No tunnel, nothing leaves your network. Prints LAN addresses to open on the
phones. The cert is self-signed here, so each device warns once — tap
**Advanced → Proceed**.

---

## The channel code

The server generates one per restart. Pin it with `PTT_CODE`:

```bash
PTT_CODE=OSCAR npm start          # bash
$env:PTT_CODE="OSCAR"; npm start  # PowerShell
```

Case doesn't matter. On a LAN it's a formality — but a `trycloudflare.com` URL
is public, and then the code is the only thing between your channel and whoever
finds the link. Pick something not guessable.

The channel holds 12; raise it with `MAX_PEERS=20`.

---

## Testing

```bash
node test.js                  # 24 checks, boots a real server
PTT_CODE=X node ghosts.js     # three fake handsets join
```

Ghosts need the same code as the server, so pin it on both.

---

## How it works

```
  phone A  ──┐
  phone B  ──┼──►  Node server  ──►  fans audio out
  phone C  ──┘   (relay + roster)     to the right peers
```

**Discovery** is the server. Every phone holds one WebSocket, so the roster is
just the set of open sockets — no broadcast packets, no mDNS. That's the thing
browsers can't do that native apps can, and a central relay sidesteps it.

**Audio** is raw 16 kHz mono PCM. An `AudioWorklet` collects 40 ms blocks,
converts to `Int16`, and ships them as binary frames — 1280 bytes each, 25 per
second, about 256 kbps. No codec to debug while getting the plumbing right.

**Playback** schedules each block on the Web Audio clock, one queue per speaker.
Slack is 80 ms on a LAN origin and 280 ms otherwise, widening to 500 ms if
frames keep landing late. Late packets are dropped rather than waited for; in
voice, a gap beats a stall.

**Floor control** is real half-duplex. One speaker holds the channel; everyone
else gets `busy` and a greyed-out bar. Without it, three people talking at once
is just noise.

---

## Wire protocol

Control messages are JSON, audio is binary.

| Direction | Message |
|---|---|
| → server | `{type:'join', name, code}` |
| → server | `{type:'talk-start', to:'all'\|<id>, sampleRate}` |
| → server | `{type:'talk-end'}` / `{type:'rename', name}` |
| → server | raw `Int16` PCM frame |
| ← client | `{type:'welcome', id, name, peers[]}` |
| ← client | `{type:'peer-join'\|'peer-leave'\|'peer-rename', ...}` |
| ← client | `{type:'talk-start', from, fromName, direct, sampleRate}` |
| ← client | `{type:'talk-end', from, reason}` |
| ← client | `{type:'floor-granted'}` / `{type:'busy', by}` |
| ← client | `{type:'denied', reason:'code'\|'full'\|'timeout'}`, then close |
| ← client | `[4-byte sender id][Int16 PCM]` |

`welcome.peers` includes you, so the unit count reads as the total on channel.

---

## Things that will bite you

**Audio over the tunnel is worse than on LAN.** The transport assumes near-zero
loss and ~1 ms jitter; neither holds over the internet. Measured round trip
through a live tunnel was ~300 ms median but ~970 ms at worst. The adaptive
buffer softens that; the real fix is Opus at 16–24 kbps instead of raw PCM.

**AP isolation.** Many routers — guest networks, hotels, cafés — block traffic
between clients, so `npm run lan` fails while Wi-Fi looks fine. It's a router
setting. Use the tunnel instead.

**Firewalls beat your firewall rules.** Third-party suites (AVG, etc.) override
Windows Firewall and block inbound on "Public" networks. The tunnel avoids this
entirely — it's an outbound connection.

**iOS Safari backgrounding.** Lock the screen and the page stops. A web app
can't hold a live channel in the background.

**Two phones in one room** will feed back. Headphones while testing.

**Everything dies with the laptop.** The server is the whole channel.

---

## Porting to mobile

The audio pipeline and PTT logic carry over almost unchanged. The transport is
what changes:

| Web (this) | Native |
|---|---|
| WebSocket to a server | UDP unicast, peer to peer |
| Server holds the roster | UDP broadcast heartbeat, or mDNS |
| Server arbitrates the floor | Same packets, peer to peer |
| Raw PCM, 256 kbps | Opus at 16–24 kbps |

Keeping the message names identical means you can port one layer at a time and
test each against the version you already trust.
