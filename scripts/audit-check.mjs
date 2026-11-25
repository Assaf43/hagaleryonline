#!/usr/bin/env node
/**
 * OWASP A06 (spec 9a.2): `npm audit --omit=dev` in CI. Fails on a high or critical advisory that is not in
 * `audit-allowlist.json`, or whose allow-list entry is past its `reviewBy` day; prints the rest as information.
 * Allow-list entry: { "id": "GHSA-…", "package": "<name>", "reason": "<why not exploitable here>", "reviewBy": "YYYY-MM-DD" }.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

const advisoryId = (advisory) => advisory.url?.match(/GHSA-[\w-]+/)?.[0] ?? `npm-${advisory.source}`;

const filled = (value) => typeof value === 'string' && value.trim() !== '';

/** A real calendar day written YYYY-MM-DD. */
const isIsoDay = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function entryProblem(entry) {
  if (typeof entry !== 'object' || entry === null) return 'not an object';
  for (const field of ['id', 'package', 'reason']) if (!filled(entry[field])) return `${field} is empty`;
  try {
    if (!isIsoDay(entry.reviewBy)) return 'reviewBy is not a YYYY-MM-DD date';
  } catch {
    return 'reviewBy is not a YYYY-MM-DD date';
  }
  return null;
}

/**
 * Pure core. `report` is `npm audit --json` (auditReportVersion 2), `today` an ISO day (YYYY-MM-DD).
 * Each advisory is counted once, on the package it belongs to (transitive entries name it by a string in `via`).
 */
export function evaluateAudit(report, allowlist, today) {
  const failures = [];
  const notes = [];
  if (!Array.isArray(allowlist)) {
    failures.push('audit-allowlist.json must be an array of entries');
    allowlist = [];
  }
  // A malformed entry is a failure of its own and covers nothing.
  allowlist = allowlist.filter((entry, i) => {
    const problem = entryProblem(entry);
    if (problem) failures.push(`allow-list entry ${i} (${entry?.id ?? 'no id'}) is invalid: ${problem}`);
    return !problem;
  });
  if (!report || report.error || typeof report.vulnerabilities !== 'object') {
    failures.push(`npm audit gave no report: ${report?.error?.summary ?? report?.error?.code ?? 'unreadable output'}`);
    return { failures, notes };
  }

  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities))
    for (const via of vulnerability.via ?? [])
      if (typeof via === 'object' && via !== null) {
        const id = advisoryId(via);
        advisories.set(`${id} ${via.name}`, {
          id,
          name: via.name,
          severity: via.severity,
          title: via.title,
          url: via.url,
        });
      }

  const seen = new Set();
  for (const a of [...advisories.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    const label = `${a.severity} ${a.id} in ${a.name}: ${a.title} (${a.url})`;
    const entry = allowlist.find((e) => e.id === a.id && e.package === a.name);
    if (entry) seen.add(entry);
    if (!BLOCKING.has(a.severity)) notes.push(`info: ${label}`);
    else if (!entry) failures.push(`not allow-listed: ${label}`);
    else if (entry.reviewBy < today) failures.push(`allow-list entry expired on ${entry.reviewBy}: ${label}`);
    else notes.push(`allow-listed until ${entry.reviewBy}: ${label} (${entry.reason})`);
  }
  for (const entry of allowlist)
    if (!seen.has(entry))
      notes.push(`allow-list entry ${entry.id} (${entry.package}) is no longer reported; remove it`);
  return { failures, notes };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const allowlist = JSON.parse(readFileSync(join(root, 'audit-allowlist.json'), 'utf8'));
  // npm audit exits 1 whenever it finds anything; the JSON on stdout is what counts.
  // A fixed command line (no user input); the shell finds npm(.cmd) on every platform.
  const run = spawnSync('npm audit --omit=dev --json', {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = { error: { summary: run.error?.message ?? (run.stderr.trim() || 'no JSON on stdout') } };
  }
  const { failures, notes } = evaluateAudit(report, allowlist, new Date().toISOString().slice(0, 10));
  for (const note of notes) console.log(note);
  for (const failure of failures) console.error(failure);
  if (failures.length) {
    console.error(`audit-check: ${failures.length} blocking advisory(ies). Upgrade, or allow-list with a reason.`);
    process.exit(1);
  }
  console.log('audit-check: no blocking advisories.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
