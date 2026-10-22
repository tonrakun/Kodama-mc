import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE, PLUGIN_LIST, REPO, TESTING } from './paths.js';

const PAPER_SHA256 = '4b011f5adb5f6c72007686a223174fce82f31aeb4b34faf4652abc840b47e640';
const PAPER_URL = `https://fill-data.papermc.io/v1/objects/${PAPER_SHA256}/paper-1.20.6-151.jar`;
const IS_WINDOWS = process.platform === 'win32';

export const HARNESS_JAR = join(TESTING, 'harness-plugin', 'build', 'libs', 'kodama-harness.jar');

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

export function kodamaJar() {
  const dir = join(REPO, 'build', 'libs');
  const match = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^kodama-paperclip-.*-mojmap\.jar$/.test(f)).sort().pop()
    : undefined;
  if (!match) throw new Error(`Kodama jar not found in ${dir}. Build it with: ./gradlew createMojmapPaperclipJar`);
  return join(dir, match);
}

export async function paperJar() {
  const dir = join(CACHE, 'jars');
  const target = join(dir, 'paper-1.20.6-151.jar');
  if (existsSync(target) && (await sha256(target)) === PAPER_SHA256) return target;
  mkdirSync(dir, { recursive: true });
  console.log(`Downloading ${PAPER_URL}`);
  const res = await fetch(PAPER_URL);
  if (!res.ok) throw new Error(`Paper download failed: HTTP ${res.status}`);
  const tmp = `${target}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const actual = await sha256(tmp);
  if (actual !== PAPER_SHA256) {
    rmSync(tmp, { force: true });
    throw new Error(`Paper jar sha256 mismatch: expected ${PAPER_SHA256}, got ${actual}`);
  }
  renameSync(tmp, target);
  return target;
}

export function runGradle(task) {
  return new Promise((resolve, reject) => {
    // Node refuses to spawn .bat files without a shell on Windows.
    const child = IS_WINDOWS
      ? spawn(`"${join(REPO, 'gradlew.bat')}" ${task}`, { cwd: REPO, stdio: 'inherit', shell: true })
      : spawn(join(REPO, 'gradlew'), [task], { cwd: REPO, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`gradlew ${task} exited with ${code}`))));
  });
}

function newestMtime(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (newest, e) => Math.max(newest, e.isDirectory() ? newestMtime(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs),
    0,
  );
}

export async function harnessJar() {
  const stale = existsSync(HARNESS_JAR) && newestMtime(join(TESTING, 'harness-plugin', 'src')) > statSync(HARNESS_JAR).mtimeMs;
  if (!existsSync(HARNESS_JAR) || stale) {
    console.log(`Harness jar ${stale ? 'is older than its sources' : 'missing'}, building it with gradle`);
    await runGradle(':kodama-harness:jar');
  }
  if (!existsSync(HARNESS_JAR)) throw new Error(`Harness jar still missing at ${HARNESS_JAR}`);
  return HARNESS_JAR;
}

export async function resolveJar(flavor) {
  return flavor === 'paper' ? paperJar() : kodamaJar();
}

export function pluginList() {
  return JSON.parse(readFileSync(PLUGIN_LIST, 'utf8'));
}

function sha512(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** Downloads a plugin from plugins.json into the cache (or reuses it) and returns the path. */
export async function pluginJar(plugin) {
  const dir = join(CACHE, 'plugins');
  const target = join(dir, plugin.file);
  if (existsSync(target) && (await sha512(target)) === plugin.sha512) return target;
  mkdirSync(dir, { recursive: true });
  console.log(`Downloading ${plugin.url}`);
  const res = await fetch(plugin.url);
  if (!res.ok) throw new Error(`${plugin.name} download failed: HTTP ${res.status}`);
  const tmp = `${target}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const actual = await sha512(tmp);
  if (actual !== plugin.sha512) {
    rmSync(tmp, { force: true });
    throw new Error(`${plugin.name} sha512 mismatch: expected ${plugin.sha512}, got ${actual}`);
  }
  renameSync(tmp, target);
  return target;
}
