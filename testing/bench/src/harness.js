import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { harnessJar, resolveJar } from './jars.js';
import { describeFailure, prepareServerDir, startServer } from './server.js';
import { startSwarm } from './bots.js';

const PREGEN_BASE_TIMEOUT_S = 900;
const PREGEN_SECONDS_PER_CHUNK = 0.1;
const METRICS_SLACK_S = 300;
export const WORLD_NAMES = { overworld: 'world', nether: 'world_nether', end: 'world_the_end' };

function commonServerOptions(flavor, dir, env, jar, jarHarness) {
  return { flavor, dir, jar, harnessJar: jarHarness, port: env.port, viewDistance: env.viewDistance, simulationDistance: env.simulationDistance };
}

/** Generates chunks [-radius, radius]^2 on a fresh server dir; resolves with the harness output dir. */
export async function runPregen({ flavor, dir, seed, radius, worlds, env, label, deterministic = false }) {
  const jar = await resolveJar(flavor);
  const harness = await harnessJar();
  prepareServerDir(dir, { ...commonServerOptions(flavor, dir, env, jar, harness), seed, deterministic });
  const out = join(dir, 'harness-out');
  mkdirSync(out, { recursive: true });
  const worldNames = worlds?.length ? worlds : Object.values(WORLD_NAMES);
  const chunks = (2 * radius + 1) ** 2 * worldNames.length;
  const sysProps = { 'kodama.harness.mode': 'pregen', 'kodama.harness.radius': radius, 'kodama.harness.out': out };
  if (worlds?.length) sysProps['kodama.harness.worlds'] = worldNames.join(',');
  if (deterministic) sysProps['kodama.harness.concurrency'] = 1;

  console.log(`[${label}] pregen radius ${radius} (${chunks} chunks) seed '${seed}'`);
  const server = startServer({
    ...env,
    flavor,
    dir,
    jar,
    label,
    sysProps,
    cpus: null,
    timeoutMs: (PREGEN_BASE_TIMEOUT_S + chunks * PREGEN_SECONDS_PER_CHUNK) * 1000,
  });
  const result = await server.exit;
  if (!existsSync(join(out, 'pregen.json'))) throw new Error(describeFailure(label, result, server.logPath));
  if (result.code !== 0) console.warn(`[${label}] server exited with code ${result.code}, but pregen.json was written`);
  return out;
}

/** Runs one measured server session with a bot swarm; resolves with { metricsPath, botsPath, logPath }. */
export async function runMetrics({ flavor, dir, worldSrc, opts, env, serverCpus, botCpus, label }) {
  const jar = await resolveJar(flavor);
  const harness = await harnessJar();
  prepareServerDir(dir, { ...commonServerOptions(flavor, dir, env, jar, harness), seed: opts.seed, worldSrc, kodamaSettings: opts.kodamaSet });
  const out = join(dir, 'harness-out');
  mkdirSync(out, { recursive: true });
  const botsPath = join(out, 'bots.json');

  console.log(`[${label}] metrics run: ${opts.bots} bots (${opts.pattern}), warmup ${opts.warmup}s, duration ${opts.duration}s`);
  const server = startServer({
    ...env,
    flavor,
    dir,
    jar,
    label,
    sysProps: {
      'kodama.harness.mode': 'metrics',
      'kodama.harness.warmup': opts.warmup,
      'kodama.harness.duration': opts.duration,
      'kodama.harness.out': out,
      'kodama.harness.botPrefix': 'bot',
    },
    cpus: serverCpus,
    timeoutMs: (opts.warmup + opts.duration + METRICS_SLACK_S) * 1000,
  });

  let swarm = null;
  try {
    await server.ready;
    swarm = startSwarm({
      label,
      cpus: botCpus,
      config: {
        host: '127.0.0.1',
        port: env.port,
        version: '1.20.6',
        botPrefix: 'bot',
        bots: opts.bots,
        pattern: opts.pattern,
        viewDistance: env.viewDistance,
        explorerSpeed: opts.explorerSpeed,
        warmupSeconds: opts.warmup,
        durationSeconds: opts.duration,
        outFile: botsPath,
      },
    });
  } catch (e) {
    console.error(`[${label}] ${e.message}`);
  }
  const result = await server.exit;
  if (swarm) await swarm.stop();

  const metricsPath = join(out, 'metrics.json');
  if (!existsSync(metricsPath)) throw new Error(describeFailure(label, result, server.logPath));
  if (!existsSync(botsPath)) throw new Error(`[${label}] swarm did not write bots.json`);
  return { metricsPath, botsPath, logPath: server.logPath };
}
