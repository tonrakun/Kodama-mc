import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessJar, resolveJar } from './jars.js';
import { RESULTS, WORK } from './paths.js';
import { describeFailure, prepareServerDir, removeDir, resolveJava, startServer } from './server.js';
import { scanConsoleLog } from './plugins-report.js';
import { buildReport, renderMarkdown } from './hoppers-report.js';
import { readJson, timestampId } from './util.js';

// The hopper settings are explicit so the run does not depend on the presets; the precache generates chunks of the default world in the background
const KODAMA_SETTINGS = ['precache.enabled=false', 'world.hoppers.enabled=true', 'world.hoppers.idle-sleep=true'];
const STARTUP_TIMEOUT_S = 180;
const SHUTDOWN_TIMEOUT_S = 60;

async function runPhase({ side, mode, resultName, sysProps, seconds, env, jar, harness, resultsDir, workDir }) {
  const dir = join(workDir, `${side.name}-${mode}`);
  prepareServerDir(dir, {
    flavor: side.flavor,
    dir,
    jar,
    harnessJar: harness,
    port: env.port,
    viewDistance: env.viewDistance,
    simulationDistance: env.simulationDistance,
    seed: 'kodama',
    kodamaSettings: side.flavor === 'kodama' ? KODAMA_SETTINGS : [],
  });
  const out = join(dir, 'harness-out');
  mkdirSync(out, { recursive: true });
  console.log(`[${side.name}] ${mode} run`);
  const server = startServer({
    ...env,
    flavor: side.flavor,
    dir,
    jar,
    label: `${side.name} ${mode}`,
    sysProps: { 'kodama.harness.mode': mode, 'kodama.harness.out': out, ...sysProps },
    cpus: null,
    timeoutMs: (STARTUP_TIMEOUT_S + seconds + SHUTDOWN_TIMEOUT_S) * 1000,
  });
  const exit = await server.exit;
  const dest = join(resultsDir, side.name);
  mkdirSync(dest, { recursive: true });
  copyFileSync(server.logPath, join(dest, `console-${mode}.log`));
  const resultPath = join(out, resultName);
  if (!existsSync(resultPath)) throw new Error(describeFailure(`${side.name} ${mode}`, exit, server.logPath));
  const result = readJson(resultPath);
  if (existsSync(join(out, 'metrics.json'))) result.metrics = readJson(join(out, 'metrics.json'));
  return result;
}

export async function runHoppers(o) {
  const flavors = o.flavors.split(',').map((f) => f.trim());
  if (flavors.length !== 2 || flavors.some((f) => f !== 'paper' && f !== 'kodama')) {
    throw new Error('--flavors needs two of paper|kodama, e.g. paper,kodama or paper,paper (baseline)');
  }
  // The first side is the reference of the comparison; a name is added when both sides are the same server
  const sides = flavors.map((flavor, i) => ({ flavor, name: flavors[0] === flavors[1] ? `${flavor}-${'ab'[i]}` : flavor }));
  const jars = {};
  for (const f of new Set(flavors)) jars[f] = await resolveJar(f);
  const harness = await harnessJar();

  const env = {
    java: resolveJava(o.java),
    heap: o.heap,
    jvmArgs: o.jvmArgs,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
  };
  const runId = timestampId('hoppers');
  const workDir = join(WORK, runId);
  const resultsDir = join(RESULTS, runId);
  mkdirSync(resultsDir, { recursive: true });

  const runs = [];
  for (const side of sides) {
    const run = { ...side, parity: null, bench: null, errorLines: [] };
    const common = { side, env, jar: jars[side.flavor], harness, resultsDir, workDir };
    try {
      run.parity = await runPhase({
        ...common,
        mode: 'hoppers',
        resultName: 'hoppers.json',
        sysProps: { 'kodama.harness.hopperTicks': o.ticks },
        seconds: o.ticks / 10,
      });
    } catch (e) {
      console.error(e.message);
      run.parityError = e.message;
    }
    if (o.bench) {
      try {
        run.bench = await runPhase({
          ...common,
          mode: 'hoppers-bench',
          resultName: 'hopper-bench.json',
          sysProps: { 'kodama.harness.hopperCount': o.benchHoppers, 'kodama.harness.warmup': o.benchWarmup, 'kodama.harness.duration': o.benchDuration },
          seconds: o.benchWarmup + o.benchDuration + 60,
        });
      } catch (e) {
        console.error(e.message);
        run.benchError = e.message;
      }
    }
    run.errorLines = [...new Set(['hoppers', 'hoppers-bench'].map((m) => join(resultsDir, side.name, `console-${m}.log`)).filter(existsSync).flatMap(scanConsoleLog))].sort();
    runs.push(run);
  }

  const report = buildReport({ runId, config: { ticks: o.ticks, bench: o.bench, benchHoppers: o.benchHoppers, benchWarmup: o.benchWarmup, benchDuration: o.benchDuration }, runs });
  writeFileSync(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = renderMarkdown(report);
  writeFileSync(join(resultsDir, 'report.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`Results written to ${resultsDir}`);
  if (!o.keepWork) removeDir(workDir);
  return report.failures.length ? 1 : 0;
}
