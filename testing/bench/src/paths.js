import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TESTING = join(REPO, 'testing');
export const CACHE = join(TESTING, '.cache');
export const WORK = join(TESTING, '.work');
export const RESULTS = join(TESTING, 'results');
export const COMPARER = join(TESTING, 'vanilla-diff', 'compare_worlds.py');
export const SWARM_SCRIPT = join(TESTING, 'bench', 'src', 'swarm.js');
export const PLUGIN_LIST = join(TESTING, 'bench', 'plugins.json');
