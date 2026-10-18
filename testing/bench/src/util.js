import { existsSync, readFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function timestampId(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function tailFile(path, lines = 30) {
  if (!existsSync(path)) return '(no log)';
  return readFileSync(path, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
