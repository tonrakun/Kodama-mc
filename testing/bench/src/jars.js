import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE, REPO, TESTING } from './paths.js';

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

export async function harnessJar() {
  if (!existsSync(HARNESS_JAR)) {
    console.log('Harness jar missing, building it with gradle');
    await runGradle(':kodama-harness:jar');
  }
  if (!existsSync(HARNESS_JAR)) throw new Error(`Harness jar still missing at ${HARNESS_JAR}`);
  return HARNESS_JAR;
}

export async function resolveJar(flavor) {
  return flavor === 'paper' ? paperJar() : kodamaJar();
}
