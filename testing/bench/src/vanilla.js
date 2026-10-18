import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPregen, WORLD_NAMES } from './harness.js';
import { resolveJar } from './jars.js';
import { COMPARER, RESULTS, WORK } from './paths.js';
import { removeDir, resolveJava } from './server.js';
import { readJson, safeName, timestampId } from './util.js';

export function findPython(preferred) {
  const candidates = preferred ? [preferred] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  throw new Error(`Python 3 not found (tried ${candidates.join(', ')}); use --python`);
}

function runComparer(python, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [COMPARER, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

export function renderParity({ runId, radius, dims, entries, labels = ['Paper', 'Kodama'], deterministic = true }) {
  const lines = [
    `# Vanilla parity ${runId}`,
    '',
    `Radius ${radius} chunks, dimensions: ${dims.join(', ')}. A = ${labels[0]}, B = ${labels[1]}. Generation: ${deterministic ? 'deterministic (1 worker)' : 'parallel'}.`,
    '',
    `| Seed | Dimension | Compared | Mismatched | Full only in A | Full only in B | Read errors | Result |`,
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  const details = [];
  for (const e of entries) {
    if (e.error) {
      lines.push(`| ${e.seed} | all | - | - | - | - | - | ERROR |`);
      details.push(`### ${e.seed}\n\n\`\`\`\n${e.error}\n\`\`\``);
      continue;
    }
    for (const [dim, r] of Object.entries(e.compare.dimensions)) {
      lines.push(`| ${e.seed} | ${dim} | ${r.chunks_compared} | ${r.chunks_mismatched} | ${r.full_only_a} | ${r.full_only_b} | ${r.read_errors} | ${r.ok ? 'OK' : 'MISMATCH'} |`);
      if (r.ok) continue;
      const cats = Object.entries(r.categories).map(([k, n]) => `${k}: ${n}`).join(', ') || r.note || 'status differences only';
      details.push(
        `### ${e.seed} / ${dim}\n\n${cats}\n\n\`\`\`\n${r.examples.map((x) => JSON.stringify(x)).join('\n')}\n\`\`\``,
      );
    }
  }
  const ok = entries.every((e) => !e.error && e.compare.ok);
  return `${lines.join('\n')}\n\n${ok ? 'All seeds match.' : '## Details\n\n' + details.join('\n\n')}\n`;
}

export async function runVanilla(o) {
  const dims = o.dims.split(',').map((d) => d.trim()).filter(Boolean);
  for (const d of dims) if (!WORLD_NAMES[d]) throw new Error(`Unknown dimension '${d}' (expected overworld, nether, end)`);
  const seeds = o.seedList ? o.seedList.split(',').map((s) => s.trim()).filter(Boolean) : Array.from({ length: o.seeds }, (_, i) => `kodama-parity-${i + 1}`);
  const python = findPython(o.python);
  const flavors = o.flavors.split(',').map((f) => f.trim());
  if (flavors.length !== 2 || flavors.some((f) => f !== 'paper' && f !== 'kodama')) {
    throw new Error(`--flavors needs two of paper|kodama, e.g. paper,kodama or paper,paper (baseline)`);
  }
  for (const f of new Set(flavors)) await resolveJar(f);
  const sides = flavors.map((f, i) => ({ flavor: f, name: `${'ab'[i]}-${f}` }));

  const env = {
    java: resolveJava(o.java),
    heap: o.heap,
    jvmArgs: o.jvmArgs,
    port: o.port,
    viewDistance: o.viewDistance,
    simulationDistance: o.simulationDistance,
  };
  const runId = timestampId('vanilla');
  const resultsDir = join(RESULTS, runId);
  mkdirSync(resultsDir, { recursive: true });
  const worlds = dims.map((d) => WORLD_NAMES[d]);
  const entries = [];

  for (const seed of seeds) {
    const seedDir = join(WORK, runId, safeName(seed));
    const entry = { seed };
    entries.push(entry);
    try {
      for (const { flavor, name } of sides) {
        await runPregen({ flavor, dir: join(seedDir, name), seed, radius: o.radius, worlds, env, label: `${name}:${seed}`, deterministic: !o.parallel });
      }
      const jsonPath = join(resultsDir, `compare-${safeName(seed)}.json`);
      const code = await runComparer(python, [
        join(seedDir, sides[0].name), join(seedDir, sides[1].name), '--dims', dims.join(','), '--radius', String(o.radius), '--json', jsonPath,
      ]);
      if (!existsSync(jsonPath)) throw new Error(`comparer exited with ${code} without writing a result`);
      entry.compare = readJson(jsonPath);
      if (code !== 0 && entry.compare.ok) entry.error = `comparer exited with ${code}`;
    } catch (e) {
      entry.error = e.message;
    }
    const passed = !entry.error && entry.compare.ok;
    console.log(`[vanilla] seed '${seed}': ${passed ? 'OK' : 'FAILED'}`);
    if (passed && !o.keepWorlds) removeDir(seedDir);
  }

  const labels = flavors.map((f) => (f === 'paper' ? 'Paper' : 'Kodama'));
  const markdown = renderParity({ runId, radius: o.radius, dims, entries, labels, deterministic: !o.parallel });
  writeFileSync(join(resultsDir, 'parity.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`Results written to ${resultsDir}`);
  return entries.every((e) => !e.error && e.compare.ok) ? 0 : 1;
}
