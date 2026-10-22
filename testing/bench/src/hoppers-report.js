const CELL_LIMIT = 200;
const DOUBLE_CHEST_SIZE = 54;

const clean = (text) => String(text ?? '').replace(/\r?\n/g, ' / ').trim();
const cell = (text) => (clean(text).length > CELL_LIMIT ? `${clean(text).slice(0, CELL_LIMIT)}...` : clean(text));
const fixed = (n, digits = 2) => (typeof n === 'number' ? n.toFixed(digits) : 'n/a');

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail: cell(detail) };
}

const entry = (e) => (e ? `tick ${e[0]} '${e[1]}'` : 'no change');

/** The earliest point where two change logs of one scenario disagree: a different tick, different contents, or a missing change. */
export function firstDifference(a, b) {
  let best = null;
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const la = a[name] ?? [];
    const lb = b[name] ?? [];
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const [ea, eb] = [la[i], lb[i]];
      if (ea && eb && ea[0] === eb[0] && ea[1] === eb[1]) continue;
      const tick = Math.min(ea?.[0] ?? Infinity, eb?.[0] ?? Infinity);
      if (!best || tick < best.tick) best = { container: name, tick, a: ea ?? null, b: eb ?? null };
      break;
    }
  }
  return best;
}

function activity(scenario) {
  const changes = Object.values(scenario.containers).flat().filter((e) => e[0] > 0);
  const last = changes.reduce((max, e) => Math.max(max, e[0]), 0);
  const afterTrigger = scenario.trigger == null ? changes.length : changes.filter((e) => e[0] > scenario.trigger).length;
  return { changes: changes.length, last, afterTrigger };
}

function parityChecks(runs, checks) {
  const [ref, other] = runs;
  const [nameA, nameB] = [ref.name, other.name];
  const byId = new Map((other.parity.scenarios ?? []).map((s) => [s.id, s]));
  const rows = [];
  for (const s of ref.parity.scenarios ?? []) {
    const t = byId.get(s.id);
    const act = activity(s);
    const diff = t ? firstDifference(s.containers, t.containers) : { container: '(scenario)', tick: 0, a: null, b: null };
    const containers = Object.keys(s.containers).length;
    let detail = `${containers} containers, ${act.changes} changes, last at tick ${act.last}`;
    let pass = true;
    if (diff) {
      pass = false;
      detail = `first difference at tick ${diff.tick}, ${diff.container}: ${nameA} ${entry(diff.a)} / ${nameB} ${entry(diff.b)}`;
    } else if (act.afterTrigger === 0) {
      pass = false;
      detail = `nothing changed after tick ${s.trigger ?? 0}, so the scenario tests nothing`;
    }
    checks.push(check(s.id, pass, detail));
    rows.push({ id: s.id, title: s.title, containers, changes: act.changes, last: act.last, difference: diff });
  }
  for (const run of runs) {
    for (const s of run.parity.scenarios ?? []) {
      if (s.id === 'double-chest-partner') {
        const size = s.notes?.doubleChestSize;
        checks.push(check(`${run.name}: double chest formed`, size === DOUBLE_CHEST_SIZE, `inventory size ${size}`));
      }
      if (s.notes?.lockedAtStart !== undefined) {
        checks.push(check(`${run.name}: ${s.id} hopper locked at the start`, s.notes.lockedAtStart === true, `locked=${s.notes.lockedAtStart}`));
      }
      if (s.id === 'item-piston') {
        checks.push(check(`${run.name}: piston extended`, s.notes?.pistonExtended === true, `extended=${s.notes?.pistonExtended}`));
      }
    }
  }
  return rows;
}

export function buildReport({ runId, config, runs }) {
  const checks = [];
  let rows = [];
  for (const run of runs) {
    if (run.parityError) checks.push(check(`${run.name}: parity run finished`, false, run.parityError.split('\n')[0]));
    else if (run.parity.error) checks.push(check(`${run.name}: parity run finished`, false, run.parity.error));
  }
  if (runs.every((r) => r.parity && !r.parity.error)) {
    rows = parityChecks(runs, checks);
  }
  for (const run of runs.filter((r) => r.flavor === 'kodama' && r.parity && !r.parity.error)) {
    checks.push(check(`${run.name}: hoppers fell asleep`, run.parity.sleepingMax > 0, `up to ${run.parity.sleepingMax} of ${run.parity.hoppers} hoppers asleep, ${run.parity.sleepingLast} at the end`));
  }

  if (config.bench) {
    for (const run of runs) {
      if (run.benchError) checks.push(check(`${run.name}: benchmark finished`, false, run.benchError.split('\n')[0]));
      else if (run.bench.error) checks.push(check(`${run.name}: benchmark finished`, false, run.bench.error));
      else if (!run.bench.metrics) checks.push(check(`${run.name}: benchmark finished`, false, 'no metrics.json'));
      else if (run.flavor === 'kodama') {
        checks.push(check(`${run.name}: benchmark hoppers fell asleep`, run.bench.sleeping > 0, `${run.bench.sleeping} of ${run.bench.hoppers} hoppers asleep`));
      }
    }
  }

  const errorLines = runs.flatMap((r) => r.errorLines.filter((l) => /hopper|FeatureGuard|dev\.kodama/i.test(l)).map((l) => `${r.name}: ${l}`));
  checks.push(check('no hopper or Kodama errors in the consoles', errorLines.length === 0, errorLines.join(' / ') || 'none'));

  const bench = config.bench
    ? runs.map((r) => ({
        name: r.name,
        hoppers: r.bench?.hoppers ?? null,
        sleeping: r.bench?.sleeping ?? null,
        mspt: r.bench?.metrics?.mspt ?? null,
        error: r.benchError ?? r.bench?.error ?? null,
      }))
    : null;
  const slim = runs.map(({ name, flavor, errorLines: lines, parity, parityError }) => ({ name, flavor, errorLines: lines, parityError, parity }));
  return { runId, config, rows, bench, checks, failures: checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), runs: slim };
}

export function renderMarkdown(report) {
  const lines = [`## Hopper idle sleep test ${report.runId}`, ''];
  lines.push(`Parity: ${report.config.ticks} ticks per run, reference ${report.runs[0].name}, compared with ${report.runs[1].name}.`, '');
  for (const c of report.checks) lines.push(`- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);

  if (report.bench) {
    const [ref, other] = report.bench;
    const delta = (a, b) => (typeof a === 'number' && typeof b === 'number' && a !== 0 ? `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(1)}%` : 'n/a');
    lines.push('', `### Benchmark (${report.config.benchHoppers} idle hoppers, warmup ${report.config.benchWarmup} s, measured ${report.config.benchDuration} s)`, '');
    lines.push(`| Metric | ${ref.name} | ${other.name} | Δ% |`, '|---|---:|---:|---:|');
    for (const [label, key] of [['MSPT avg (ms)', 'avg'], ['MSPT p50 (ms)', 'p50'], ['MSPT p95 (ms)', 'p95'], ['MSPT p99 (ms)', 'p99'], ['MSPT max (ms)', 'max']]) {
      lines.push(`| ${label} | ${fixed(ref.mspt?.[key])} | ${fixed(other.mspt?.[key])} | ${delta(ref.mspt?.[key], other.mspt?.[key])} |`);
    }
    for (const b of report.bench) {
      if (b.sleeping != null) lines.push('', `${b.name}: ${b.sleeping} of ${b.hoppers} hoppers asleep (\`/kodama status\`).`);
    }
  }

  lines.push('', '### Result', '', ...(report.failures.length ? report.failures.map((f) => `- FAIL ${f}`) : ['- PASS all checks']));
  return `${lines.join('\n')}\n`;
}
