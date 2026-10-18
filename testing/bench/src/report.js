import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './util.js';

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && typeof v.avg === 'number') return v.avg;
  return null;
};
const sumWorlds = (m, key) => {
  const worlds = Object.values(m.worlds ?? {});
  return worlds.length ? worlds.reduce((s, w) => s + (num(w[key]) ?? 0), 0) : null;
};

export const ROWS = [
  { id: 'mspt.avg', label: 'MSPT avg (ms)', get: (m) => num(m.mspt?.avg), digits: 2 },
  { id: 'mspt.p99', label: 'MSPT p99 (ms)', get: (m) => num(m.mspt?.p99), digits: 2 },
  { id: 'mspt.max', label: 'MSPT max (ms)', get: (m) => num(m.mspt?.max), digits: 2 },
  { id: 'mspt.over50', label: 'Ticks > 50 ms', get: (m) => num(m.mspt?.over50), digits: 0 },
  { id: 'mspt.over100', label: 'Ticks > 100 ms', get: (m) => num(m.mspt?.over100), digits: 0 },
  { id: 'tps', label: 'TPS', get: (m) => num(m.tps), digits: 2 },
  { id: 'gc.count', label: 'GC count', get: (m) => num(m.gc?.count), digits: 0 },
  { id: 'gc.maxPauseMs', label: 'GC max pause (ms)', get: (m) => num(m.gc?.maxPauseMs), digits: 1 },
  { id: 'gc.p99PauseMs', label: 'GC p99 pause (ms)', get: (m) => num(m.gc?.p99PauseMs), digits: 1 },
  { id: 'allocBytesPerTick', label: 'Alloc bytes/tick', get: (m) => num(m.allocBytesPerTick), digits: 0 },
  { id: 'heap.usedAvgMB', label: 'Heap used avg (MB)', get: (m) => num(m.heap?.usedAvgMB), digits: 0 },
  { id: 'heap.usedMaxMB', label: 'Heap used max (MB)', get: (m) => num(m.heap?.usedMaxMB), digits: 0 },
  { id: 'bandwidth', label: 'Bandwidth per bot (KiB/s)', get: (_, b) => (num(b?.bytesReceived?.perBotPerSecondAvg) ?? NaN) / 1024, digits: 1 },
  { id: 'chunkLatency.avg', label: 'Chunk latency avg (ms)', get: (_, b) => num(b?.chunkLatencyMs?.avg), digits: 0 },
  { id: 'chunkLatency.p99', label: 'Chunk latency p99 (ms)', get: (_, b) => num(b?.chunkLatencyMs?.p99), digits: 0 },
  { id: 'chunksMissing', label: 'Chunks missing >5s', get: (_, b) => num(b?.chunksMissingOver5s), digits: 0 },
  { id: 'explorerSpeed', label: 'Explorer speed (blocks/s)', get: (_, b) => num(b?.explorerSpeedAvg), digits: 1 },
  { id: 'mobs', label: 'Mobs (living, non-player)', get: (m) => num(m.mobs?.total), digits: 0 },
  { id: 'despawns', label: 'Despawns', get: (m) => num(m.mobs?.despawns), digits: 0 },
  { id: 'entities', label: 'Entities', get: (m) => sumWorlds(m, 'entities'), digits: 0 },
];

const clean = (v) => (v === null || Number.isNaN(v) ? null : v);
const fmt = (v, digits) => (v === null ? 'n/a' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));

export function deltaPercent(base, other) {
  if (base === null || other === null || base === 0) return null;
  return ((other - base) / Math.abs(base)) * 100;
}

/** servers: { paper?: {metrics, bots}, kodama?: {metrics, bots} } */
export function buildReport({ runId, config, servers }) {
  const names = Object.keys(servers);
  const rows = ROWS.map((row) => {
    const values = Object.fromEntries(names.map((n) => [n, clean(row.get(servers[n].metrics, servers[n].bots))]));
    const delta = names.length === 2 ? deltaPercent(values.paper, values.kodama) : null;
    return { id: row.id, label: row.label, digits: row.digits, values, deltaPercent: delta };
  });
  return { runId, config, servers: names, rows };
}

export function renderMarkdown(report) {
  const both = report.servers.length === 2;
  const title = (n) => n[0].toUpperCase() + n.slice(1);
  const head = ['Metric', ...report.servers.map(title), ...(both ? ['Δ%'] : [])];
  const lines = [
    `## Benchmark ${report.runId}`,
    '',
    `Bots: ${report.config.bots} (${report.config.pattern}), warmup ${report.config.warmup}s, duration ${report.config.duration}s, ` +
      `view/simulation distance ${report.config.viewDistance}/${report.config.simulationDistance}, heap ${report.config.heap}, seed \`${report.config.seed}\``,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`,
  ];
  for (const row of report.rows) {
    const cells = report.servers.map((n) => fmt(row.values[n], row.digits));
    if (both) cells.push(row.deltaPercent === null ? 'n/a' : `${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}%`);
    lines.push(`| ${[row.label, ...cells].join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** Returns human-readable failures where Kodama is worse than Paper by more than `percent`. */
export function findRegressions(report, percent) {
  if (report.servers.length !== 2) return [];
  return report.rows
    .filter((r) => r.id === 'mspt.avg' || r.id === 'mspt.p99')
    .filter((r) => r.deltaPercent !== null && r.deltaPercent > percent)
    .map((r) => `${r.label}: Kodama ${fmt(r.values.kodama, r.digits)} vs Paper ${fmt(r.values.paper, r.digits)} (+${r.deltaPercent.toFixed(1)}% > ${percent}%)`);
}

/** Copies per-server artifacts into the results dir and writes report.json / report.md. */
export function writeResults({ resultsDir, runId, config, runs }) {
  mkdirSync(resultsDir, { recursive: true });
  const servers = {};
  for (const [name, run] of Object.entries(runs)) {
    const dest = join(resultsDir, name);
    mkdirSync(dest, { recursive: true });
    copyFileSync(run.metricsPath, join(dest, 'metrics.json'));
    copyFileSync(run.botsPath, join(dest, 'bots.json'));
    if (existsSync(run.logPath)) copyFileSync(run.logPath, join(dest, 'console.log'));
    servers[name] = { metrics: readJson(run.metricsPath), bots: readJson(run.botsPath) };
  }
  const report = buildReport({ runId, config, servers });
  const markdown = renderMarkdown(report);
  writeFileSync(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(resultsDir, 'report.md'), markdown);
  return { report, markdown };
}
