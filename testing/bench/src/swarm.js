// Bot swarm child process. Configuration arrives as JSON in KODAMA_SWARM; stop via IPC message or SIGTERM.
import { writeFileSync } from 'node:fs';
import mineflayer from 'mineflayer';
import { summarize } from './stats.js';

const cfg = JSON.parse(process.env.KODAMA_SWARM);
const STAGGER_MS = 1000;
const MOVE_TICK_MS = 50;
const CHUNK_TICK_MS = 250;
const MISSING_AFTER_MS = 5000;
const SETTLER_RING_RADIUS = 64;
const SETTLER_WANDER_RADIUS = 24;
const EXPLORER_Y = 160;

const startedAt = Date.now();
// Measurement starts after the warmup; the harness measures from roughly the same moment.
const windowStart = startedAt + cfg.warmupSeconds * 1000;
const latencies = [];
const kicks = [];
let stopping = false;

const roleOf = (i) => (cfg.pattern === 'mixed' ? (i % 2 === 0 ? 'settler' : 'explorer') : cfg.pattern);
const states = Array.from({ length: cfg.bots }, (_, i) => ({
  i,
  name: `${cfg.botPrefix}${String(i).padStart(3, '0')}`,
  role: roleOf(i),
  bot: null,
  hooked: false,
  bytes: 0,
  bytesAtWindow: null,
  spawned: false,
  ended: false,
  moving: false,
  required: new Map(),
  loaded: new Set(),
}));
for (const role of ['settler', 'explorer']) {
  const group = states.filter((s) => s.role === role);
  group.forEach((s, k) => {
    s.groupIndex = k;
    s.groupSize = group.length;
  });
}

const colKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
const sinceStart = () => Math.round((Date.now() - startedAt) / 100) / 10;

function record(st, type, reason) {
  kicks.push({ bot: st.name, type, atSeconds: sinceStart(), reason: typeof reason === 'string' ? reason : JSON.stringify(reason) });
}

function connect(st) {
  let settle;
  st.joined = new Promise((r) => (settle = r));
  setTimeout(settle, 60000);
  const bot = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: st.name,
    version: cfg.version,
    auth: 'offline',
    viewDistance: cfg.viewDistance,
    checkTimeoutInterval: 120000,
    physicsEnabled: st.role !== 'explorer',
    // minecraft-protocol cannot fully parse some 1.20.6 registry/item data and dumps huge stack traces;
    // the bots do not use those packets.
    hideErrors: true,
  });
  st.bot = bot;

  // Count wire bytes (post-compression) straight from the socket.
  const hook = () => {
    const socket = bot._client.socket;
    if (!socket || st.hooked) return;
    st.hooked = true;
    socket.on('data', (b) => {
      st.bytes += b.length;
    });
  };
  bot._client.on('connect', hook);
  bot._client.on('login', hook);
  hook();

  bot.once('spawn', () => {
    st.spawned = true;
    settle();
  });
  bot.on('chunkColumnLoad', (p) => {
    const key = colKey(Math.floor(p.x / 16), Math.floor(p.z / 16));
    st.loaded.add(key);
    const t0 = st.required.get(key);
    if (t0 === undefined) return;
    st.required.delete(key);
    if (t0 >= windowStart) latencies.push(Date.now() - t0);
  });
  bot.on('chunkColumnUnload', (p) => st.loaded.delete(colKey(Math.floor(p.x / 16), Math.floor(p.z / 16))));
  bot.on('kicked', (reason) => {
    record(st, 'kicked', reason);
    settle();
  });
  bot.on('error', (e) => {
    record(st, 'error', String(e?.message ?? e));
    settle();
  });
  bot.on('end', (reason) => {
    st.ended = true;
    if (!stopping) record(st, 'ended', String(reason));
    settle();
  });
}

function trackChunks() {
  const t = Date.now();
  const vd = cfg.viewDistance;
  for (const st of states) {
    if (!st.spawned || st.ended || !st.bot.entity) continue;
    const bcx = Math.floor(st.bot.entity.position.x / 16);
    const bcz = Math.floor(st.bot.entity.position.z / 16);
    const wanted = new Set();
    for (let cx = bcx - vd; cx <= bcx + vd; cx++) {
      for (let cz = bcz - vd; cz <= bcz + vd; cz++) {
        const key = colKey(cx, cz);
        wanted.add(key);
        if (!st.loaded.has(key) && !st.required.has(key)) st.required.set(key, t);
      }
    }
    for (const key of st.required.keys()) if (!wanted.has(key)) st.required.delete(key);
  }
}

function snapshotWindowStart() {
  for (const st of states) {
    st.bytesAtWindow = st.bytes;
    st.traveledAtWindow = st.traveled ?? 0;
  }
}

function pickTarget(st) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * SETTLER_WANDER_RADIUS;
  st.target = { x: st.home.x + Math.cos(a) * r, z: st.home.z + Math.sin(a) * r };
  st.stuckMs = 0;
  st.lastLookAt = 0;
}

function startMoving(st) {
  // afk bots stand where the harness put them (e.g. next to the trap tower)
  if (st.role === 'afk') return;
  const pos = st.bot.entity.position;
  const a = (Math.PI * 2 * st.groupIndex) / st.groupSize;
  if (st.role === 'settler') {
    st.home = { x: pos.x + Math.cos(a) * SETTLER_RING_RADIUS, z: pos.z + Math.sin(a) * SETTLER_RING_RADIUS };
    st.target = { ...st.home };
    st.sample = { t: Date.now(), x: pos.x, z: pos.z };
    st.stuckMs = 0;
    st.jump = false;
    st.lastLookAt = 0;
    st.bot.setControlState('forward', true);
    st.bot.setControlState('sprint', true);
  } else {
    st.dx = Math.cos(a);
    st.dz = Math.sin(a);
    st.lastT = Date.now();
    pos.y = EXPLORER_Y;
    st.bot.entity.velocity.set(0, 0, 0);
    st.bot.entity.onGround = false;
    st.bot.entity.yaw = Math.atan2(-st.dx, -st.dz);
    st.bot.physicsEnabled = false;
    try {
      st.bot.creative.startFlying();
    } catch {
      // Not in creative yet; the server-side allowFlight setting is what matters.
    }
  }
  st.moving = true;
}

function settlerTick(st, t) {
  const pos = st.bot.entity.position;
  if (Math.hypot(st.target.x - pos.x, st.target.z - pos.z) < 1.5) pickTarget(st);

  if (t - st.sample.t >= 1000) {
    const moved = Math.hypot(pos.x - st.sample.x, pos.z - st.sample.z);
    st.stuckMs = moved < 0.5 ? st.stuckMs + (t - st.sample.t) : 0;
    st.jump = moved < 0.5;
    st.sample = { t, x: pos.x, z: pos.z };
    if (st.stuckMs >= 5000) pickTarget(st);
  }
  if (t - st.lastLookAt >= 500) {
    st.lastLookAt = t;
    st.bot.lookAt(pos.offset(st.target.x - pos.x, 0, st.target.z - pos.z), true).catch(() => {});
  }
  st.bot.setControlState('jump', st.jump);
}

function explorerTick(st, t) {
  const dt = (t - st.lastT) / 1000;
  st.lastT = t;
  const pos = st.bot.entity.position;
  const step = cfg.explorerSpeed * dt;
  // Never outrun the loaded area: the server only sends chunks around positions it has received.
  if (st.bot.blockAt(pos.offset(st.dx * step * 4, 0, st.dz * step * 4)) == null) return;
  pos.x += st.dx * step;
  pos.z += st.dz * step;
  st.traveled = (st.traveled ?? 0) + step;
  pos.y = EXPLORER_Y;
}

function moveTick() {
  const t = Date.now();
  for (const st of states) {
    if (!st.moving || st.ended || !st.bot.entity) continue;
    try {
      if (st.role === 'settler') settlerTick(st, t);
      else explorerTick(st, t);
    } catch (e) {
      record(st, 'error', `movement: ${e.message}`);
    }
  }
}

const SHUTDOWN_RE = /server_shutdown|Server closed/;

function buildResult(endedAt) {
  const inWindow = endedAt >= windowStart;
  const windowSeconds = Math.max(0.001, (endedAt - (inWindow ? windowStart : startedAt)) / 1000);
  const total = states.reduce((sum, st) => sum + st.bytes - (inWindow ? st.bytesAtWindow ?? 0 : 0), 0);
  const missing = states.reduce(
    (sum, st) => (st.ended ? sum : sum + [...st.required.values()].filter((t0) => endedAt - t0 > MISSING_AFTER_MS).length),
    0,
  );
  const kickedBots = new Set(kicks.filter((k) => k.type === 'kicked').map((k) => k.bot));
  const realKicks = kicks.filter((k) => {
    if (k.type === 'kicked') return !SHUTDOWN_RE.test(k.reason);
    // Connections that close right before we stop are the server shutting down, not failures.
    if (k.type === 'ended') return !kickedBots.has(k.bot) && k.atSeconds < (endedAt - startedAt) / 1000 - 5;
    return true;
  });
  return {
    bots: cfg.bots,
    botsJoined: states.filter((s) => s.spawned).length,
    pattern: cfg.pattern,
    durationSeconds: windowSeconds,
    bytesReceived: { total, perBotPerSecondAvg: total / cfg.bots / windowSeconds },
    chunkLatencyMs: summarize(latencies),
    chunksMissingOver5s: missing,
    explorerSpeedAvg: explorerSpeed(inWindow, windowSeconds),
    kicks: realKicks,
  };
}

// Explorers stop when the chunk ahead is not there yet, so slow chunk delivery shows up as lower speed.
function explorerSpeed(inWindow, windowSeconds) {
  const explorers = states.filter((st) => st.role === 'explorer' && st.spawned);
  if (explorers.length === 0) return null;
  const dist = explorers.reduce((sum, st) => sum + (st.traveled ?? 0) - (inWindow ? st.traveledAtWindow ?? 0 : 0), 0);
  return dist / explorers.length / windowSeconds;
}

let intervals = [];
function finish() {
  if (stopping) return;
  stopping = true;
  intervals.forEach(clearInterval);
  const result = buildResult(Date.now());
  writeFileSync(cfg.outFile, JSON.stringify(result, null, 2));
  console.log(`swarm done: ${result.botsJoined}/${result.bots} joined, ${result.kicks.length} kicks, ${result.chunkLatencyMs.count} chunk samples`);
  for (const st of states) {
    try {
      st.bot?.quit();
    } catch {
      // already disconnected
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('message', (m) => m === 'stop' && finish());
process.on('SIGTERM', finish);
process.on('uncaughtException', (e) => {
  console.error(`uncaught: ${e.stack ?? e}`);
  kicks.push({ bot: '*', type: 'exception', atSeconds: sinceStart(), reason: String(e.message ?? e) });
});

states.forEach((st, i) => setTimeout(() => connect(st), i * STAGGER_MS));
intervals = [setInterval(trackChunks, CHUNK_TICK_MS), setInterval(moveTick, MOVE_TICK_MS)];
setTimeout(snapshotWindowStart, Math.max(0, windowStart - Date.now()));
setTimeout(finish, (cfg.warmupSeconds + cfg.durationSeconds) * 1000);

setTimeout(async () => {
  await Promise.all(states.map((s) => s.joined ?? Promise.resolve()));
  await new Promise((r) => setTimeout(r, 2000));
  for (const st of states) if (st.spawned && !st.ended) startMoving(st);
  console.log(`swarm: ${states.filter((s) => s.moving).length}/${cfg.bots} bots moving (${cfg.pattern})`);
}, (cfg.bots - 1) * STAGGER_MS + 100);
