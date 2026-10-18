import { spawnPinned } from './affinity.js';
import { SWARM_SCRIPT } from './paths.js';

/** Starts the bot swarm as a separate node process so it can be pinned to its own CPUs. */
export function startSwarm({ config, cpus, label }) {
  const child = spawnPinned(
    process.execPath,
    [SWARM_SCRIPT],
    { env: { ...process.env, KODAMA_SWARM: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
    cpus,
  );
  child.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `[${label} bots] `)));

  const exited = new Promise((resolve) => child.on('close', resolve));

  // SIGTERM would hard-kill the child on Windows, so ask it to finish over IPC.
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      child.send('stop');
    } catch {
      child.kill();
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    await exited;
    clearTimeout(killer);
  };
  return { stop, exited };
}
