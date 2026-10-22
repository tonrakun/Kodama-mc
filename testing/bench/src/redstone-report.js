import { existsSync, readFileSync } from 'node:fs';

const TOLERANCE = 0.1;
const CELL_LIMIT = 200;

const clean = (text) => String(text ?? '').replace(/\r?\n/g, ' / ').trim();
const cell = (text) => (clean(text).length > CELL_LIMIT ? `${clean(text).slice(0, CELL_LIMIT)}...` : clean(text));
const rate = (phase) => phase?.signalTogglesPerSecond;
const fixed = (n) => (typeof n === 'number' ? n.toFixed(2) : String(n));

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail: cell(detail) };
}

/** Whether `actual` is within the tolerance of `expected`; a clock that never toggled is no baseline. */
function sameRate(name, label, expected, actual) {
  const detail = `${label} ${fixed(actual)}/s, baseline ${fixed(expected)}/s`;
  return check(name, expected > 0 && actual > 0 && Math.abs(actual - expected) <= TOLERANCE * expected, detail);
}

export function readConsole(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function buildReport({ runId, run1, run2, console1, errorLines }) {
  const checks = [];
  const failed = (run, label) => {
    if (run.error) checks.push(check(`${label} finished`, false, run.error));
    return Boolean(run.error);
  };
  const [chunkX, chunkZ] = run1.chunkA ?? [0, 0];
  const world = run1.world ?? 'harness_redstone';

  const ok1 = !failed(run1, 'run 1');
  if (ok1) {
    const baseline = rate(run1.baseline);
    checks.push(check('clock drives the lamp signal', baseline > 0, `${fixed(baseline)} toggles/s over ${run1.baseline.seconds} s (lamp lit changes: ${run1.baseline.lampToggles})`));
    checks.push(check('lever lamp in chunk B lit', run1.lampBLit === true, `lit=${run1.lampBLit}`));
    checks.push(check('info chunk A is continuous (clock)', run1.infoA.includes('continuous (clock)'), run1.infoA));
    checks.push(check('info chunk A starts on the world implementation', run1.infoA.includes('world implementation'), run1.infoA));
    checks.push(check('info chunk B is transient or idle', /transient|no redstone activity/.test(run1.infoB), run1.infoB));
    const first = run1.top.split(/\r?\n/).find((l) => l.trim()) ?? '';
    checks.push(check('top lists chunk A first', first.includes(`${world} ${chunkX} ${chunkZ}:`), run1.top));
    const warning = new RegExp(String.raw`\[Kodama\] Redstone clock at ${world} chunk ${chunkX} ${chunkZ}\b`);
    checks.push(check('console warns about the clock in chunk A', warning.test(console1), warning.test(console1) ? 'warning found' : 'no warning in console.log'));
    checks.push(check('set alternate-current accepted', run1.setOutput.includes('Switching chunk'), run1.setOutput));
    checks.push(check('info reports Alternate Current within 15 s', run1.switchSeconds != null, `after ${run1.switchSeconds ?? '>15'} s`));
    checks.push(sameRate('clock rate unchanged with Alternate Current', 'Alternate Current', baseline, rate(run1.alternateCurrent)));
  }

  if (run2) {
    const ok2 = !failed(run2, 'run 2');
    if (ok2) {
      checks.push(check('info reports Alternate Current after restart', run2.infoAtStart.includes('Alternate Current') && run2.infoAfterRestart.includes('Alternate Current'), `${run2.infoAtStart} | ${run2.infoAfterRestart}`));
      checks.push(sameRate('clock rate unchanged after restart', 'after restart', ok1 ? rate(run1.baseline) : 0, rate(run2.afterRestart)));
      checks.push(check('set vanilla accepted', run2.setVanillaOutput.includes('Switching chunk'), run2.setVanillaOutput));
      checks.push(check('info reports world implementation within 15 s', run2.switchBackSeconds != null, `after ${run2.switchBackSeconds ?? '>15'} s`));
      checks.push(check('clock still runs on the world implementation', rate(run2.vanilla) > 0, `${fixed(rate(run2.vanilla))} toggles/s`));
    }
  } else {
    checks.push(check('run 2 finished', false, 'not started'));
  }
  checks.push(check('no Kodama or redstone errors in the consoles', errorLines.length === 0, errorLines.join(' / ') || 'none'));

  return { runId, run1, run2, checks, failures: checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`) };
}

export function renderMarkdown(report) {
  const lines = [`## Redstone monitoring test ${report.runId}`, ''];
  for (const c of report.checks) lines.push(`- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  const row = (name, phase) => (phase ? `| ${name} | ${phase.seconds} | ${phase.signalToggles} | ${fixed(phase.signalTogglesPerSecond)} | ${phase.lampToggles} |` : null);
  const rows = [
    row('implementation of the world (run 1)', report.run1.baseline),
    row('Alternate Current (run 1)', report.run1.alternateCurrent),
    row('Alternate Current after restart (run 2)', report.run2?.afterRestart),
    row('implementation of the world again (run 2)', report.run2?.vanilla),
  ].filter(Boolean);
  lines.push('', '| Phase | Seconds | Signal toggles | Signal toggles/s | Lamp toggles |', '|---|---|---|---|---|', ...rows);
  lines.push('', '### Result', '', ...(report.failures.length ? report.failures.map((f) => `- FAIL ${f}`) : ['- PASS all checks']));
  return `${lines.join('\n')}\n`;
}
