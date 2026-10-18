import { spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnPinned } from './affinity.js';
import { CACHE } from './paths.js';
import { tailFile } from './util.js';

const running = new Set();
// Paperclip downloads the vanilla jar and libraries on first start; reuse them across runs.
const PAPERCLIP_DIRS = ['cache', 'libraries'];

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function killAll() {
  for (const child of running) killTree(child);
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAll();
    process.exit(130);
  });
}

export function resolveJava(javaOption) {
  if (javaOption) return javaOption;
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return 'java';
}

export function prepareServerDir(dir, o) {
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n');
  writeFileSync(
    join(dir, 'server.properties'),
    [
      'online-mode=false',
      `level-seed=${o.seed}`,
      `server-port=${o.port}`,
      `view-distance=${o.viewDistance}`,
      `simulation-distance=${o.simulationDistance}`,
      'spawn-protection=0',
      'max-players=500',
      'enable-command-block=false',
      'sync-chunk-writes=false',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'spigot.yml'), 'settings:\n  moved-too-quickly-multiplier: 1000.0\n  moved-wrongly-threshold: 1000.0\n');
  if (o.flavor === 'kodama' && o.kodamaSettings?.length) {
    // "world.<key>=value" goes to the world defaults file, everything else to the global file
    const world = o.kodamaSettings.filter((s) => s.startsWith('world.')).map((s) => s.slice('world.'.length));
    const global = o.kodamaSettings.filter((s) => !s.startsWith('world.'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    if (global.length) writeFileSync(join(dir, 'config', 'kodama-global.yml'), toNestedYaml(global));
    if (world.length) writeFileSync(join(dir, 'config', 'kodama-world-defaults.yml'), toNestedYaml(world));
  }
  if (o.deterministic) {
    // Features spill into neighbour chunks, so the result depends on generation order; one worker makes it fixed.
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'paper-global.yml'), 'chunk-system:\n  worker-threads: 1\n');
  }
  cpSync(o.harnessJar, join(dir, 'plugins', 'kodama-harness.jar'));
  for (const name of PAPERCLIP_DIRS) {
    const cached = join(CACHE, 'paperclip', o.flavor, name);
    if (existsSync(cached)) cpSync(cached, join(dir, name), { recursive: true });
  }
  for (const world of o.worldSrc ? ['world', 'world_nether', 'world_the_end'] : []) {
    const src = join(o.worldSrc, world);
    if (existsSync(src)) copyWorld(src, join(dir, world));
  }
}

/** ['a.b=1', 'a.c=x'] -> nested YAML; Kodama fills in every key that is not given. */
export function toNestedYaml(settings) {
  const root = {};
  for (const entry of settings) {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new Error(`--kodama-set expects key=value, got '${entry}'`);
    const path = entry.slice(0, eq).split('.');
    let node = root;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path.at(-1)] = entry.slice(eq + 1);
  }
  const lines = [];
  const walk = (node, indent) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'object') {
        lines.push(`${indent}${k}:`);
        walk(v, `${indent}  `);
      } else {
        lines.push(`${indent}${k}: ${v}`);
      }
    }
  };
  walk(root, '');
  return `${lines.join('\n')}\n`;
}

export function copyWorld(src, dest) {
  cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('session.lock') });
}

function saveDownloadCache(dir, flavor) {
  for (const name of PAPERCLIP_DIRS) {
    const cached = join(CACHE, 'paperclip', flavor, name);
    if (existsSync(join(dir, name)) && !existsSync(cached)) {
      mkdirSync(join(CACHE, 'paperclip', flavor), { recursive: true });
      cpSync(join(dir, name), cached, { recursive: true });
    }
  }
}

/**
 * Starts a server process and returns { child, ready, exit, pid }.
 * `ready` resolves on the "Done (" line and rejects if the server exits first.
 * `exit` always resolves with { code, timedOut }.
 */
export function startServer(o) {
  const args = [
    `-Xms${o.heap}`,
    `-Xmx${o.heap}`,
    // jansi crashes on Windows when stdio is piped.
    '-Dterminal.jline=false',
    '-Dterminal.ansi=false',
    ...Object.entries(o.sysProps ?? {}).map(([k, v]) => `-D${k}=${v}`),
    ...(o.jvmArgs ?? []),
    '-jar',
    o.jar,
    '--nogui',
  ];
  const logPath = join(o.dir, 'console.log');
  const log = createWriteStream(logPath);
  const child = spawnPinned(o.java, args, { cwd: o.dir, stdio: ['pipe', 'pipe', 'pipe'] }, o.cpus);
  running.add(child);

  let timedOut = false;
  let readySeen = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {});

  let tail = '';
  const onData = (chunk) => {
    log.write(chunk);
    if (readySeen) return;
    tail = (tail + chunk.toString('utf8')).slice(-512);
    if (tail.includes('Done (')) {
      readySeen = true;
      resolveReady();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.stdin.write('stop\n');
    await new Promise((r) => setTimeout(r, 20000).unref());
    killTree(child);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[${o.label}] timed out after ${Math.round(o.timeoutMs / 1000)}s, stopping server`);
    stop();
  }, o.timeoutMs);

  const exit = new Promise((resolve) => {
    const done = (code) => {
      clearTimeout(timer);
      running.delete(child);
      log.end();
      if (!readySeen) rejectReady(new Error(`server exited (${code}) before it was ready`));
      if (code === 0) saveDownloadCache(o.dir, o.flavor);
      resolve({ code, timedOut });
    };
    child.on('error', (e) => {
      console.error(`[${o.label}] failed to start: ${e.message}`);
      done(-1);
    });
    child.on('close', done);
  });

  return { child, ready, exit, stop, logPath };
}

export function describeFailure(label, result, logPath) {
  const why = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
  return `${label} ${why}. Last console output:\n${tailFile(logPath)}`;
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
