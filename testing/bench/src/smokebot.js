import mineflayer from 'mineflayer';
import { sleep } from './util.js';

const SPAWN_TIMEOUT_MS = 60000;
const BEFORE_FIRST_COMMAND_MS = 1500;
const REPLY_WAIT_MS = 2000;

/**
 * Joins as one bot, sends the commands as chat and collects the replies of each. The bot stays online
 * until the server stops, because the harness ends the run.
 */
export function startSmokeBot({ name, port, version, viewDistance, commands }) {
  const result = { name, spawned: false, commands: [], ended: null };
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: name,
    version,
    auth: 'offline',
    viewDistance,
    checkTimeoutInterval: 120000,
    hideErrors: true,
  });
  let current = null;
  bot.on('messagestr', (message) => current?.replies.push(message));
  bot.on('kicked', (reason) => {
    result.ended = `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`;
  });
  bot.on('error', (e) => {
    result.ended ??= `error: ${e?.message ?? e}`;
  });
  bot.on('end', (reason) => {
    result.ended ??= String(reason);
  });

  const spawned = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bot ${name} did not spawn within ${SPAWN_TIMEOUT_MS / 1000}s`)), SPAWN_TIMEOUT_MS);
    bot.once('spawn', () => {
      clearTimeout(timer);
      result.spawned = true;
      resolve();
    });
  });

  const done = (async () => {
    await spawned;
    await sleep(BEFORE_FIRST_COMMAND_MS);
    for (const command of commands) {
      current = { command, replies: [] };
      result.commands.push(current);
      bot.chat(command);
      await sleep(REPLY_WAIT_MS);
    }
    current = null;
  })();
  done.catch((e) => {
    result.ended ??= e.message;
  });

  const stop = async () => {
    try {
      bot.quit();
    } catch {
      // already disconnected
    }
    await done.catch(() => {});
  };
  return { result, stop };
}
