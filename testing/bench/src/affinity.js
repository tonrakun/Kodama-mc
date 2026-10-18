import { spawn, spawnSync } from 'node:child_process';
import { cpus as osCpus } from 'node:os';

export function parseCpuList(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid CPU list: ${spec}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    for (let i = lo; i <= hi; i++) out.push(i);
  }
  return out;
}

/** Returns { server, bots } CPU arrays, or null entries when pinning is disabled or unsupported. */
export function resolveAffinity({ noAffinity, serverCpus, botCpus }) {
  const none = { server: null, bots: null };
  if (noAffinity) return none;
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    console.warn(`CPU pinning is not supported on ${process.platform}; running unpinned`);
    return none;
  }
  const server = parseCpuList(serverCpus);
  const bots = parseCpuList(botCpus);
  const needed = Math.max(...server, ...bots) + 1;
  const available = osCpus().length;
  if (available < needed) {
    console.warn(`CPU pinning disabled: ${available} logical CPUs available, ${needed} requested`);
    return none;
  }
  return { server, bots };
}

/** Spawns a process, pinned to `cpus` when given. */
export function spawnPinned(command, args, options, cpus) {
  if (!cpus) return spawn(command, args, options);
  if (process.platform === 'linux') {
    return spawn('taskset', ['-c', cpus.join(','), command, ...args], options);
  }
  const child = spawn(command, args, options);
  if (!child.pid) return child;
  // Windows has no spawn-time affinity; setting it right after start covers all JVM threads.
  const mask = cpus.reduce((acc, c) => acc + 2 ** c, 0);
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid}).ProcessorAffinity = ${mask}`],
    { stdio: 'ignore' },
  );
  if (r.status !== 0) console.warn(`Failed to set CPU affinity for pid ${child.pid}`);
  return child;
}
