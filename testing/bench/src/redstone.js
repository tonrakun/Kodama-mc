import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessJar, kodamaJar } from './jars.js';
import { RESULTS, WORK } from './paths.js';
import { describeFailure, prepareServerDir, removeDir, resolveJava, startServer } from './server.js';
import { scanConsoleLog } from './plugins-report.js';
import { buildReport, readConsole, renderMarkdown } from './redstone-report.js';
import { readJson, timestampId } from './util.js';

// Low enough that the clock of the test reaches the notification threshold; the default is 300 updates/s.
const KODAMA_SETTINGS = ['world.redstone.enabled=true', 'world.redstone.notify-updates-per-second=5'];
const STARTUP_TIMEOUT_S = 180;
const SHUTDOWN_TIMEOUT_S = 60;

async function runPhase({ mode, resultName, seconds, dir, jar, env, resultsDir }) {
  const out = join(dir, 'harness-out');
  mkdirSync(out, { recursive: true });
  console.log(`[kodama] redstone ${mode} run`);
  const server = startServer({
    ...env,
    flavor: 'kodama',
    dir,
    jar,
    label: mode,
    sysProps: {
      'kodama.harness.mode': mode,
      'kodama.harness.out': out,
      'kodama.harness.redstoneSeconds': env.measure,
      'kodama.harness.followUpSeconds': env.followUp,
    },
    cpus: null,
    timeoutMs: (STARTUP_TIMEOUT_S + seconds + SHUTDOWN_TIMEOUT_S) * 1000,
  });
  const exit = await server.exit;
  // The next run writes its console.log over this one
  copyFileSync(server.logPath, join(resultsDir, `console-${mode}.log`));
  const resultPath = join(out, resultName);
  if (!existsSync(resultPath)) throw new Error(describeFailure(mode, exit, server.logPath));
  return readJson(resultPath);
}

export async function runRedstone(o) {
  const jar = kodamaJar();
  const harness = await harnessJar();
  const env = { java: resolveJava(o.java), heap: o.heap, jvmArgs: o.jvmArgs, port: o.port, measure: o.measure, followUp: o.followUp };

  const runId = timestampId('redstone');
  const dir = join(WORK, runId, 'kodama');
  const resultsDir = join(RESULTS, runId);
  mkdirSync(resultsDir, { recursive: true });
  prepareServerDir(dir, {
    flavor: 'kodama',
    dir,
    jar,
    harnessJar: harness,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
    seed: 'kodama',
    kodamaSettings: KODAMA_SETTINGS,
  });

  const phase = { dir, jar, env, resultsDir };
  let run1;
  let run2 = null;
  try {
    run1 = await runPhase({ ...phase, mode: 'redstone', resultName: 'redstone.json', seconds: o.measure + o.followUp });
  } catch (e) {
    run1 = { error: e.message };
  }
  if (!run1.error) {
    try {
      run2 = await runPhase({ ...phase, mode: 'redstone-verify', resultName: 'redstone-verify.json', seconds: o.followUp * 2 + 30 });
    } catch (e) {
      run2 = { error: e.message };
    }
  }

  const consoles = ['redstone', 'redstone-verify'].map((m) => join(resultsDir, `console-${m}.log`)).filter(existsSync);
  const errorLines = [...new Set(consoles.flatMap(scanConsoleLog))].filter((l) => /redstone|kodama/i.test(l)).sort();
  const report = buildReport({ runId, run1, run2, console1: readConsole(join(resultsDir, 'console-redstone.log')), errorLines });
  writeFileSync(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = renderMarkdown(report);
  writeFileSync(join(resultsDir, 'report.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`Results written to ${resultsDir}`);
  if (!o.keepWork) removeDir(join(WORK, runId));
  return report.failures.length ? 1 : 0;
}
