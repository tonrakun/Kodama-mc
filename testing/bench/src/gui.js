import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mineflayer from 'mineflayer';
import { kodamaJar } from './jars.js';
import { RESULTS, WORK } from './paths.js';
import { describeFailure, prepareServerDir, removeDir, resolveJava, startServer } from './server.js';
import { sleep, timestampId } from './util.js';

const OP = 'guiop';
const USER = 'guiuser';
const VERSION = '1.20.6';
const STARTUP_TIMEOUT_S = 240;
const SPAWN_TIMEOUT_MS = 90000;
const CLICK_WAIT_MS = 400;
const TOP_SLOTS = 54;

// Slots of the bottom row
const BACK = 45;
const WORLD = 49;
const REDSTONE = 51;

async function waitFor(condition, timeoutMs, step = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

/** Plain text of an item stack: name plus the serialized components, so a name or lore line can be searched. */
function textOf(item) {
  return item ? `${item.name} ${JSON.stringify(item.components ?? item.nbt ?? {})}` : '';
}

async function joinBot(name, port, viewDistance) {
  const state = { name, bot: null, chat: [], window: null, opened: 0, ended: null };
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: name,
    version: VERSION,
    auth: 'offline',
    viewDistance,
    checkTimeoutInterval: 120000,
    hideErrors: true,
  });
  state.bot = bot;
  bot.on('messagestr', (m) => state.chat.push(m));
  bot.on('windowOpen', (w) => {
    state.window = w;
    state.opened++;
  });
  bot.on('windowClose', (w) => {
    if (state.window === w) state.window = null;
  });
  bot.on('kicked', (reason) => {
    state.ended = `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`;
  });
  bot.on('error', (e) => {
    state.ended ??= `error: ${e?.message ?? e}`;
  });
  bot.on('end', (reason) => {
    state.ended ??= String(reason);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bot ${name} did not spawn within ${SPAWN_TIMEOUT_MS / 1000}s`)), SPAWN_TIMEOUT_MS);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(1500);
  return state;
}

/** Slot of the first top-inventory item whose text contains `needle`, or -1. */
function slotOf(state, needle) {
  const window = state.window;
  if (!window) return -1;
  for (let i = 0; i < TOP_SLOTS; i++) {
    if (textOf(window.slots[i]).includes(needle)) return i;
  }
  return -1;
}

function itemAt(state, slot) {
  return state.window?.slots[slot] ?? null;
}

/** mode 0 = normal click, 1 = shift click, 4 = drop; button 0 = left, 1 = right. */
async function click(state, slot, { button = 0, mode = 0 } = {}) {
  await Promise.race([state.bot.clickWindow(slot, button, mode).catch(() => {}), sleep(1500)]);
  await sleep(CLICK_WAIT_MS);
}

/** Clicks and waits for the GUI to open a new window (category or back). */
async function clickAndOpen(state, slot) {
  const before = state.opened;
  await click(state, slot);
  return waitFor(() => state.opened > before, 5000);
}

async function runCommand(state, command, { expectWindow = false } = {}) {
  const before = state.opened;
  state.bot.chat(command);
  if (expectWindow) return waitFor(() => state.opened > before, 8000);
  await sleep(1500);
  return true;
}

async function waitChat(state, from, pattern, timeoutMs = 4000) {
  return waitFor(() => state.chat.slice(from).find((m) => pattern.test(m)), timeoutMs);
}

/** Value of a dotted path in a YAML file written by Kodama (two space indentation, no flow style). */
function yamlGet(path, dottedPath) {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const keys = dottedPath.split('.');
  let from = 0;
  for (let k = 0; k < keys.length; k++) {
    const indent = k * 2;
    let found = -1;
    for (let i = from; i < lines.length; i++) {
      const m = lines[i].match(/^( *)([^\s#:][^:]*):(.*)$/);
      if (!m) continue;
      if (m[1].length < indent) break;
      if (m[1].length === indent && m[2] === keys[k]) {
        found = i;
        if (k === keys.length - 1) return m[3].trim().replace(/^['"]|['"]$/g, '');
        break;
      }
    }
    if (found < 0) return undefined;
    from = found + 1;
  }
  return undefined;
}

export async function runGui(o) {
  const jar = kodamaJar();
  const env = { java: resolveJava(o.java), heap: o.heap, jvmArgs: o.jvmArgs, port: o.port };
  const runId = timestampId('gui');
  const dir = join(WORK, runId, 'kodama');
  const resultsDir = join(RESULTS, runId);
  mkdirSync(resultsDir, { recursive: true });
  prepareServerDir(dir, {
    flavor: 'kodama',
    dir,
    jar,
    harnessJar: null,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
    seed: 'kodama',
  });
  const globalFile = join(dir, 'config', 'kodama-global.yml');
  const worldDefaultsFile = join(dir, 'config', 'kodama-world-defaults.yml');
  const worldFile = join(dir, 'world', 'kodama-world.yml');

  const checks = [];
  const check = (name, pass, detail = '') => {
    checks.push({ name, pass: Boolean(pass), detail: String(detail) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    return Boolean(pass);
  };

  console.log('[kodama] config GUI run');
  const server = startServer({
    ...env,
    flavor: 'kodama',
    dir,
    jar,
    label: 'gui',
    sysProps: {},
    cpus: null,
    timeoutMs: (STARTUP_TIMEOUT_S + 240) * 1000,
  });

  let failure = null;
  const bots = [];
  try {
    await server.ready;
    server.child.stdin.write(`op ${OP}\n`);
    const op = await joinBot(OP, o.port, o.viewDistance);
    bots.push(op);
    const user = await joinBot(USER, o.port, o.viewDistance);
    bots.push(user);
    await sleep(1000);
    await scenario({ op, user, check, globalFile, worldDefaultsFile, worldFile });
  } catch (e) {
    failure = e;
    check('test run completed', false, e.stack ?? e.message);
  } finally {
    for (const state of bots) {
      try {
        state.bot.quit();
      } catch {
        // already gone
      }
    }
    server.child.stdin.write('stop\n');
    await Promise.race([server.exit, sleep(60000)]);
    await server.stop();
  }
  const exit = await server.exit;
  if (failure && !existsSync(server.logPath)) console.error(describeFailure('gui', exit, server.logPath));

  const logText = existsSync(server.logPath) ? readFileSync(server.logPath, 'utf8') : '';
  const guiErrors = logText.split(/\r?\n/).filter((l) => /Kodama config GUI failed|ConfigGui|ConfigGuiListener/.test(l));
  check('console has no GUI errors', guiErrors.length === 0, guiErrors.slice(0, 3).join(' | '));

  const failed = checks.filter((c) => !c.pass);
  const lines = [
    `# Config GUI test ${runId}`,
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/').replace(/\r?\n/g, ' / ').slice(0, 200)} |`),
    '',
    failed.length ? `${failed.length} of ${checks.length} checks failed.` : `All ${checks.length} checks passed.`,
    '',
  ];
  writeFileSync(join(resultsDir, 'report.md'), lines.join('\n'));
  writeFileSync(join(resultsDir, 'report.json'), JSON.stringify({ runId, checks }, null, 2));
  if (existsSync(server.logPath)) writeFileSync(join(resultsDir, 'console.log'), logText);
  console.log(`\n${failed.length ? `${failed.length} of ${checks.length} checks failed` : `All ${checks.length} checks passed`}`);
  console.log(`Results written to ${resultsDir}`);
  if (!o.keepWork) removeDir(join(WORK, runId));
  return failed.length ? 1 : 0;
}

async function scenario({ op, user, check, globalFile, worldDefaultsFile, worldFile }) {
  // Non-op players have no config permission, so the command is not available to them
  await runCommand(user, '/kodama gui');
  check('non-op cannot open the GUI', user.opened === 0 && !user.window, `windows opened: ${user.opened}`);

  const opened = await runCommand(op, '/kodama gui', { expectWindow: true });
  check('op opens the GUI', opened && op.window, `window ${JSON.stringify(op.window?.title ?? 'none')}`);
  if (process.env.GUI_DEBUG) {
    for (let i = 0; i < 12; i++) console.log(i, textOf(itemAt(op, i)).slice(0, 400));
  }
  check('top page has the categories', ['grass_block', 'hopper', 'redstone', 'zombie_head', 'clock'].every((m) => slotOf(op, m) >= 0)
    && itemAt(op, WORLD)?.name === 'compass', op.window ? op.window.slots.slice(0, 12).map((s) => s?.name ?? '-').join(',') : '');

  // The first entry is the preset, an enum
  let from = op.chat.length;
  check('preset item is an enum', itemAt(op, 0)?.name === 'comparator');
  await click(op, 0);
  check('enum left click selects the next value', yamlGet(globalFile, 'preset') === 'aggressive', yamlGet(globalFile, 'preset'));
  await runCommand(op, '/kodama config undo');
  check('undo reverts the preset', yamlGet(globalFile, 'preset') === 'balanced', yamlGet(globalFile, 'preset'));

  // Category chunk-loading, boolean and number
  check('chunk-loading category opens', await clickAndOpen(op, slotOf(op, 'grass_block')), JSON.stringify(op.window?.title));
  const enabledSlot = 0;
  const numberSlot = 1;
  check('first option is a boolean switch (on)', itemAt(op, enabledSlot)?.name === 'lime_wool', textOf(itemAt(op, enabledSlot)).slice(0, 200));
  check('second option is a number', itemAt(op, numberSlot)?.name === 'gold_ingot', textOf(itemAt(op, numberSlot)).slice(0, 200));
  check('lore shows value, default, reload timing', ['Value:', 'Default:', 'Reload:'].every((t) => textOf(itemAt(op, enabledSlot)).includes(t)));

  from = op.chat.length;
  await click(op, enabledSlot);
  check('boolean click is confirmed in chat', await waitChat(op, from, /Set chunk-loading\.enabled/), op.chat.slice(from).join(' / '));
  check('global file has chunk-loading.enabled: false', yamlGet(globalFile, 'chunk-loading.enabled') === 'false', yamlGet(globalFile, 'chunk-loading.enabled'));
  check('boolean item turned red in place', await waitFor(() => itemAt(op, enabledSlot)?.name === 'red_wool', 3000));

  const before = yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick');
  from = op.chat.length;
  await click(op, numberSlot);
  check('number left click raises the value by 1', yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick') === '5',
    `${before} -> ${yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick')}`);
  await click(op, numberSlot, { button: 1, mode: 1 });
  check('number shift right click lowers the value by 10', yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick') === '-5',
    yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick'));
  await click(op, numberSlot, { mode: 4 });
  check('drop resets a preset value to default', yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick') === 'default',
    yamlGet(globalFile, 'chunk-loading.max-ticking-promotions-per-tick'));

  // /kodama config undo goes through the same history: drop, shift-right, left, boolean
  for (const [label, path, expected] of [
    ['undo reverts the reset', 'chunk-loading.max-ticking-promotions-per-tick', '-5'],
    ['undo reverts the shift step', 'chunk-loading.max-ticking-promotions-per-tick', '5'],
    ['undo reverts the first step', 'chunk-loading.max-ticking-promotions-per-tick', 'default'],
    ['undo reverts the boolean switch', 'chunk-loading.enabled', 'default'],
  ]) {
    await runCommand(op, '/kodama config undo');
    check(label, yamlGet(globalFile, path) === expected, `${path} = ${yamlGet(globalFile, path)}`);
  }

  // Validation errors keep the GUI open and the value unchanged
  check('back to the top page', await clickAndOpen(op, BACK));
  check('feature-safety category opens', await clickAndOpen(op, slotOf(op, 'shield')));
  const limitSlot = slotOf(op, 'max-exceptions');
  check('max-exceptions item found', limitSlot >= 0, `slot ${limitSlot}`);
  await click(op, limitSlot, { button: 1, mode: 1 });
  check('shift right click lowers max-exceptions by 10', yamlGet(globalFile, 'feature-safety.max-exceptions') === '10', yamlGet(globalFile, 'feature-safety.max-exceptions'));
  from = op.chat.length;
  const windowsBefore = op.opened;
  await click(op, limitSlot, { button: 1, mode: 1 });
  check('out of range value is rejected with a chat message', await waitChat(op, from, /Not changed/), op.chat.slice(from).join(' / '));
  check('rejected value is not written', yamlGet(globalFile, 'feature-safety.max-exceptions') === '10', yamlGet(globalFile, 'feature-safety.max-exceptions'));
  check('GUI stays open after a rejected change', op.window && op.opened === windowsBefore && itemAt(op, BACK)?.name === 'arrow');
  await runCommand(op, '/kodama config undo');
  check('undo restores max-exceptions', yamlGet(globalFile, 'feature-safety.max-exceptions') === '20', yamlGet(globalFile, 'feature-safety.max-exceptions'));

  // World options go to the world defaults unless another world is selected
  await clickAndOpen(op, BACK);
  await clickAndOpen(op, slotOf(op, 'zombie_head'));
  const lodSlot = 0;
  check('mob-lod first option is a switch', ['lime_wool', 'red_wool'].includes(itemAt(op, lodSlot)?.name), itemAt(op, lodSlot)?.name);
  const lodBefore = yamlGet(worldDefaultsFile, 'mob-lod.enabled');
  await click(op, lodSlot);
  check('world option is written to kodama-world-defaults.yml', yamlGet(worldDefaultsFile, 'mob-lod.enabled') === 'false', `${lodBefore} -> ${yamlGet(worldDefaultsFile, 'mob-lod.enabled')}`);
  await runCommand(op, '/kodama config undo');
  check('undo reverts the world defaults', yamlGet(worldDefaultsFile, 'mob-lod.enabled') === 'default', yamlGet(worldDefaultsFile, 'mob-lod.enabled'));

  // World selector, then a per world file
  await clickAndOpen(op, BACK);
  check('world selector starts on the world defaults', textOf(itemAt(op, WORLD)).includes('world defaults'), textOf(itemAt(op, WORLD)).slice(0, 200));
  await click(op, WORLD);
  check('world selector cycles to the world "world"', await waitFor(() => /"World: world"|World: world(?!\s*defaults)/.test(textOf(itemAt(op, WORLD))), 3000), textOf(itemAt(op, WORLD)).slice(0, 200));
  await clickAndOpen(op, slotOf(op, 'hopper'));
  await click(op, 0);
  check('world option is written to the world file', yamlGet(worldFile, 'hoppers.enabled') === 'false', `${worldFile}: ${yamlGet(worldFile, 'hoppers.enabled')}`);
  await runCommand(op, '/kodama config undo');
  // A key that was not in the world file before is removed again, so the world inherits the defaults
  check('undo reverts the world file', [undefined, 'default'].includes(yamlGet(worldFile, 'hoppers.enabled')), `hoppers.enabled = ${yamlGet(worldFile, 'hoppers.enabled')}`);

  // /kodama gui <world>
  await runCommand(op, '/kodama gui world', { expectWindow: true });
  check('/kodama gui <world> preselects the world', textOf(itemAt(op, WORLD)).includes('world') && !textOf(itemAt(op, WORLD)).includes('world defaults'), textOf(itemAt(op, WORLD)).slice(0, 200));

  // Redstone button for the chunk the player stands in
  check('redstone button is shown', itemAt(op, REDSTONE)?.name === 'redstone', itemAt(op, REDSTONE)?.name);
  from = op.chat.length;
  await click(op, REDSTONE);
  check('redstone button asks for the switch', await waitChat(op, from, /Switching chunk/), op.chat.slice(from).join(' / '));
  from = op.chat.length;
  await sleep(2000);
  op.bot.chat('/kodama redstone info');
  check('the chunk uses Alternate Current', await waitChat(op, from, /Alternate Current/, 5000), op.chat.slice(from).join(' / '));

  // Items can never be taken out
  await click(op, 30, { mode: 1 });
  await click(op, 35, { button: 1, mode: 0 });
  await click(op, 40, { mode: 4 });
  await sleep(500);
  check('no item can be taken from the GUI', op.bot.inventory.items().length === 0 && !op.bot.inventory.cursorItem,
    op.bot.inventory.items().map((i) => i.name).join(','));
  op.bot.closeWindow(op.window);
  await sleep(500);
  check('bot inventory is empty after closing', op.bot.inventory.items().length === 0);
}
