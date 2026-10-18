import { join } from 'node:path';
import { resolveAffinity } from './affinity.js';
import { runMetrics } from './harness.js';
import { resolveJar } from './jars.js';
import { RESULTS, WORK } from './paths.js';
import { findRegressions, writeResults } from './report.js';
import { removeDir, resolveJava } from './server.js';
import { timestampId } from './util.js';
import { ensurePregenWorld } from './worlds.js';

export async function runBench(o) {
  const names = o.server === 'both' ? ['paper', 'kodama'] : [o.server];
  if (!['paper', 'kodama', 'both'].includes(o.server)) throw new Error(`--server must be paper, kodama or both (got ${o.server})`);
  if (!['settler', 'explorer', 'mixed', 'afk'].includes(o.pattern)) throw new Error(`--pattern must be settler, explorer, mixed or afk (got ${o.pattern})`);
  if (o.failOnRegression !== null && names.length !== 2) throw new Error('--fail-on-regression requires --server both');

  // Fail before the long world generation if a jar is unavailable.
  for (const name of names) await resolveJar(name);

  const env = {
    java: resolveJava(o.java),
    heap: o.heap,
    jvmArgs: o.jvmArgs,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
  };
  const affinity = resolveAffinity(o);
  const worldSrc = await ensurePregenWorld({ seed: o.seed, radius: o.pregenRadius, env });

  const runId = timestampId('bench');
  const workDir = join(WORK, runId);
  const runs = {};
  for (const name of names) {
    runs[name] = await runMetrics({
      flavor: name,
      dir: join(workDir, name),
      worldSrc,
      opts: o,
      env,
      serverCpus: affinity.server,
      botCpus: affinity.bots,
      label: name,
    });
  }

  const config = {
    bots: o.bots,
    pattern: o.pattern,
    warmup: o.warmup,
    duration: o.duration,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
    heap: o.heap,
    seed: o.seed,
    pregenRadius: o.pregenRadius,
    explorerSpeed: o.explorerSpeed,
    pinned: Boolean(affinity.server),
  };
  const resultsDir = join(RESULTS, runId);
  const { report, markdown } = writeResults({ resultsDir, runId, config, runs });
  console.log(`\n${markdown}`);
  console.log(`Results written to ${resultsDir}`);
  if (!o.keepWork) removeDir(workDir);

  if (o.failOnRegression !== null) {
    const failures = findRegressions(report, o.failOnRegression);
    if (failures.length) {
      console.error(`Regression above ${o.failOnRegression}%:\n  ${failures.join('\n  ')}`);
      return 1;
    }
  }
  return 0;
}
