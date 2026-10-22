import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSmokeBot } from './smokebot.js';
import { harnessJar, pluginJar, pluginList, resolveJar } from './jars.js';
import { RESULTS, WORK } from './paths.js';
import { describeFailure, prepareServerDir, removeDir, resolveJava, startServer } from './server.js';
import { buildReport, renderMarkdown, scanConsoleLog } from './plugins-report.js';
import { readJson, timestampId } from './util.js';

const BOT_NAME = 'bot000';
const SMOKE_TIMEOUT_S = 300;
const JOIN_TIMEOUT_S = 120;
const CONSOLE_COMMANDS = ['lp info', 'we version', 'essentials version', 'protocol version', 'viaversion'];
const KODAMA_COMMANDS = ['kodama version', 'kodama status'];
// Chat commands of the plugins that work without any configuration
const BOT_COMMANDS = ['/lp info', '//pos1', '/essentials:balance', '/essentials:ping', '/essentials:getpos'];

async function runSmoke({ flavor, dir, plugins, env }) {
  const jar = await resolveJar(flavor);
  const harness = await harnessJar();
  prepareServerDir(dir, {
    flavor,
    dir,
    jar,
    harnessJar: harness,
    port: env.port,
    viewDistance: env.viewDistance,
    simulationDistance: env.simulationDistance,
    seed: 'kodama',
  });
  for (const [plugin, path] of plugins) copyFileSync(path, join(dir, 'plugins', plugin.file));
  const out = join(dir, 'harness-out');
  mkdirSync(out, { recursive: true });

  const commands = flavor === 'kodama' ? [...CONSOLE_COMMANDS, ...KODAMA_COMMANDS] : CONSOLE_COMMANDS;
  console.log(`[${flavor}] smoke run with ${plugins.length} plugins`);
  const server = startServer({
    ...env,
    flavor,
    dir,
    jar,
    label: flavor,
    sysProps: {
      'kodama.harness.mode': 'smoke',
      'kodama.harness.out': out,
      'kodama.harness.botPrefix': 'bot',
      // The harness splits the list at semicolons because the commands contain spaces
      'kodama.harness.commands': commands.join(';'),
      'kodama.harness.botCommands': BOT_COMMANDS.length,
      'kodama.harness.joinTimeout': JOIN_TIMEOUT_S,
    },
    cpus: null,
    timeoutMs: SMOKE_TIMEOUT_S * 1000,
  });

  let bot = null;
  try {
    await server.ready;
    bot = startSmokeBot({ name: BOT_NAME, port: env.port, version: '1.20.6', viewDistance: env.viewDistance, commands: BOT_COMMANDS });
  } catch (e) {
    console.error(`[${flavor}] ${e.message}`);
  }
  const exit = await server.exit;
  if (bot) await bot.stop();

  const smokePath = join(out, 'smoke.json');
  if (!existsSync(smokePath)) throw new Error(describeFailure(flavor, exit, server.logPath));
  return { smoke: readJson(smokePath), bot: bot?.result ?? null, logPath: server.logPath };
}

export async function runPlugins(o) {
  const flavors = o.flavors.split(',').map((f) => f.trim());
  if (flavors.some((f) => f !== 'paper' && f !== 'kodama') || new Set(flavors).size !== flavors.length) {
    throw new Error('--flavors needs paper, kodama or paper,kodama (each at most once)');
  }
  for (const f of flavors) await resolveJar(f);
  const plugins = [];
  for (const plugin of pluginList()) plugins.push([plugin, await pluginJar(plugin)]);

  const env = {
    java: resolveJava(o.java),
    heap: o.heap,
    jvmArgs: o.jvmArgs,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
  };
  const runId = timestampId('plugins');
  const workDir = join(WORK, runId);
  const resultsDir = join(RESULTS, runId);
  mkdirSync(resultsDir, { recursive: true });

  const runs = {};
  for (const flavor of flavors) {
    try {
      const run = await runSmoke({ flavor, dir: join(workDir, flavor), plugins, env });
      const dest = join(resultsDir, flavor);
      mkdirSync(dest, { recursive: true });
      copyFileSync(run.logPath, join(dest, 'console.log'));
      writeFileSync(join(dest, 'smoke.json'), JSON.stringify(run.smoke, null, 2));
      runs[flavor] = { smoke: run.smoke, bot: run.bot, errorLines: scanConsoleLog(run.logPath) };
    } catch (e) {
      console.error(e.message);
      runs[flavor] = { error: e.message };
    }
  }

  const report = buildReport({ runId, plugins: plugins.map(([p]) => p), runs });
  writeFileSync(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  const markdown = renderMarkdown(report);
  writeFileSync(join(resultsDir, 'report.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`Results written to ${resultsDir}`);
  if (!o.keepWork) removeDir(workDir);
  return report.failures.length ? 1 : 0;
}
