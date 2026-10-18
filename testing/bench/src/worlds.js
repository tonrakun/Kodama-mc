import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runPregen, WORLD_NAMES } from './harness.js';
import { CACHE, WORK } from './paths.js';
import { copyWorld, removeDir } from './server.js';
import { safeName } from './util.js';

export function worldCacheDir(seed, radius) {
  return join(CACHE, 'worlds', `${safeName(seed)}-r${radius}-overworld`);
}

/**
 * Pre-generates the shared test world with Paper once and caches it, so both servers
 * start from identical chunks (fixed seed + pre-generated world).
 * Only the overworld is pre-generated: the bots never leave it.
 */
export async function ensurePregenWorld({ seed, radius, env }) {
  const cacheDir = worldCacheDir(seed, radius);
  if (existsSync(join(cacheDir, 'pregen.json'))) {
    console.log(`Using cached world ${cacheDir}`);
    return cacheDir;
  }
  const dir = join(WORK, `worldgen-${safeName(seed)}-r${radius}`);
  removeDir(dir);
  const out = await runPregen({ flavor: 'paper', dir, seed, radius, worlds: [WORLD_NAMES.overworld], env, label: 'worldgen' });

  const staging = `${cacheDir}.tmp`;
  removeDir(staging);
  mkdirSync(staging, { recursive: true });
  for (const name of Object.values(WORLD_NAMES)) {
    if (existsSync(join(dir, name))) copyWorld(join(dir, name), join(staging, name));
  }
  copyWorld(join(out, 'pregen.json'), join(staging, 'pregen.json'));
  // pregen.json is the completeness marker, so the directory is renamed into place last.
  removeDir(cacheDir);
  renameSync(staging, cacheDir);
  removeDir(dir);
  return cacheDir;
}
