import { readFileSync } from 'node:fs';

const LINE = /^\[\d{2}:\d{2}:\d{2}(?:\s+([A-Z]+)\]|\]\s+\[[^\]]*?\/([A-Z]+)\]):\s?(.*)$/;
const EXCEPTION = /\b(?:[A-Za-z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error)\b|\bError:/;
const CELL_LIMIT = 160;

/** Removes what differs between two otherwise identical runs: timestamps, addresses, ids and the server directory. */
function normalize(text) {
  return text
    .replace(/[^\s"']*[\\/]\.work[\\/]plugins-\d+-\d+[\\/](?:paper|kodama)/g, '<server>')
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/@[0-9a-f]{5,}\b|\b0x[0-9a-f]+\b/g, '<addr>')
    .trim();
}

/** Lines of a console log that are ERROR level or start an exception, normalized and without duplicates. */
export function scanConsoleLog(path) {
  const found = new Set();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s+at /.test(raw)) continue;
    const m = LINE.exec(raw);
    const level = m ? (m[1] ?? m[2]) : null;
    const message = m ? m[3] : raw;
    if (level === 'ERROR' || EXCEPTION.test(message)) found.add(normalize(message));
  }
  found.delete('');
  return [...found].sort();
}

const checksOf = (run) => Object.entries(run.smoke?.kodamaChecks ?? {});

export function buildReport({ runId, plugins, runs }) {
  const { paper, kodama } = runs;
  const failures = [];
  for (const [flavor, run] of Object.entries(runs)) {
    if (run.error) failures.push(`${flavor}: run failed: ${run.error.split('\n')[0]}`);
    else if (run.smoke.error) failures.push(`${flavor}: ${run.smoke.error}`);
  }

  const paperOk = paper && !paper.error;
  const kodamaOk = kodama && !kodama.error;
  if (paperOk && kodamaOk) {
    for (const p of paper.smoke.plugins ?? []) {
      const other = (kodama.smoke.plugins ?? []).find((k) => k.name === p.name);
      if (p.enabled && !other?.enabled) failures.push(`plugin ${p.name} is enabled on Paper but ${other ? 'not enabled' : 'missing'} on Kodama`);
    }
  }
  if (kodamaOk) {
    for (const c of kodama.smoke.commands ?? []) {
      const onPaper = paperOk && (paper.smoke.commands ?? []).find((x) => x.command === c.command);
      if (c.threw && !onPaper?.threw) failures.push(`command '${c.command}' threw on Kodama only: ${c.threw}`);
    }
    for (const [name, check] of checksOf(kodama)) {
      if (!check?.pass) failures.push(`Kodama check ${name} failed: ${check?.reason ?? 'no result'}`);
    }
  }

  const diff = { onlyKodama: [], onlyPaper: [] };
  if (paperOk && kodamaOk) {
    diff.onlyKodama = kodama.errorLines.filter((l) => !paper.errorLines.includes(l));
    diff.onlyPaper = paper.errorLines.filter((l) => !kodama.errorLines.includes(l));
    for (const line of diff.onlyKodama) failures.push(`error line only in Kodama: ${line}`);
  }
  return { runId, plugins: plugins.map((p) => p.name), runs, diff, failures };
}

const cell = (text) => {
  const flat = String(text ?? '').replace(/\r?\n/g, ' / ').replace(/\|/g, '\\|').trim();
  return flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT)}...` : flat;
};
const title = (flavor) => flavor[0].toUpperCase() + flavor.slice(1);
const bullets = (items) => (items.length ? items.map((l) => `- ${cell(l)}`) : ['- none']);

export function renderMarkdown(report) {
  const flavors = Object.keys(report.runs);
  const lines = [`## Plugin smoke test ${report.runId}`, ''];

  lines.push(`| Plugin | ${flavors.map(title).join(' | ')} |`, `|---|${flavors.map(() => '---').join('|')}|`);
  const seen = new Set(flavors.flatMap((f) => (report.runs[f].smoke?.plugins ?? []).map((p) => p.name)));
  for (const name of [...report.plugins, ...[...seen].filter((n) => !report.plugins.includes(n))]) {
    const cells = flavors.map((f) => {
      const p = (report.runs[f].smoke?.plugins ?? []).find((x) => x.name === name);
      return p ? `${p.version} ${p.enabled ? 'enabled' : 'DISABLED'}` : 'missing';
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }

  for (const flavor of flavors) {
    const run = report.runs[flavor];
    lines.push('', `### ${title(flavor)}`, '');
    if (run.error) {
      lines.push('```', run.error, '```');
      continue;
    }
    lines.push('| Console command | Handled | Threw | Output |', '|---|---|---|---|');
    for (const c of run.smoke.commands ?? []) lines.push(`| \`${c.command}\` | ${c.handled} | ${cell(c.threw) || '-'} | ${cell(c.output)} |`);
    lines.push('', '| Bot command | Known | Replies |', '|---|---|---|');
    const received = run.smoke.botCommands ?? [];
    for (const c of run.bot?.commands ?? []) {
      const server = received.find((s) => s.command === c.command);
      lines.push(`| \`${c.command}\` | ${server ? server.known : 'not seen'} | ${cell(c.replies.join(' / ')) || '-'} |`);
    }
    if (run.bot?.ended) lines.push('', `Bot ended: ${cell(run.bot.ended)}`);
    const checks = checksOf(run);
    if (checks.length) {
      lines.push('');
      for (const [name, check] of checks) {
        const detail = Object.entries(check ?? {}).filter(([k]) => k !== 'pass').map(([k, v]) => `${k}=${v}`).join(', ');
        lines.push(`- ${check?.pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${cell(detail)}` : ''}`);
      }
    }
    lines.push('', `Console errors (${run.errorLines.length} distinct):`, '', ...bullets(run.errorLines));
  }

  if (flavors.length === 2) {
    lines.push('', '### Console error lines that differ', '', `Only in Kodama (${report.diff.onlyKodama.length}):`, '', ...bullets(report.diff.onlyKodama));
    lines.push('', `Only in Paper (${report.diff.onlyPaper.length}):`, '', ...bullets(report.diff.onlyPaper));
  }

  lines.push('', '### Result', '', ...(report.failures.length ? report.failures.map((f) => `- FAIL ${f}`) : ['- PASS all checks']));
  return `${lines.join('\n')}\n`;
}
