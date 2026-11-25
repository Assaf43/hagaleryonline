import { describe, expect, it } from 'vitest';
import { evaluateAudit } from './audit-check.mjs';

const advisory = (name, severity, id) => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} problem`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<9.9.9',
});

/** The shape of `npm audit --json` (auditReportVersion 2): a transitive entry names its source in `via` as a string. */
const report = (...advisories) => {
  const vulnerabilities = {};
  for (const a of advisories)
    vulnerabilities[a.name] = {
      name: a.name,
      severity: a.severity,
      via: [a],
      effects: ['parent'],
      fixAvailable: false,
    };
  vulnerabilities.parent = { name: 'parent', severity: 'high', via: advisories.map((a) => a.name), effects: [] };
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
};

const TODAY = '2026-11-25';
const entry = (id, pkg, reviewBy = '2027-01-31') => ({ id, package: pkg, reason: 'not reachable', reviewBy });

describe('evaluateAudit', () => {
  it('passes a clean report', () => {
    expect(evaluateAudit({ auditReportVersion: 2, vulnerabilities: {} }, [], TODAY)).toEqual({
      failures: [],
      notes: [],
    });
  });

  it('fails an unlisted high advisory, once, by its GHSA id (transitive "via" strings are not double counted)', () => {
    const { failures } = evaluateAudit(report(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc')), [], TODAY);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('GHSA-aaaa-bbbb-cccc');
    expect(failures[0]).toContain('lib');
  });

  it('passes an allow-listed high advisory and notes it', () => {
    const result = evaluateAudit(
      report(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc')),
      [entry('GHSA-aaaa-bbbb-cccc', 'lib')],
      TODAY,
    );
    expect(result.failures).toEqual([]);
    expect(result.notes.join('\n')).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('the reviewBy day itself still passes; the day after fails', () => {
    const r = report(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc'));
    expect(evaluateAudit(r, [entry('GHSA-aaaa-bbbb-cccc', 'lib', TODAY)], TODAY).failures).toEqual([]);
    const expired = evaluateAudit(r, [entry('GHSA-aaaa-bbbb-cccc', 'lib', '2026-11-24')], TODAY).failures;
    expect(expired).toHaveLength(1);
    expect(expired[0]).toContain('2026-11-24');
  });

  it('an entry for another package does not cover the advisory', () => {
    const r = report(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc'));
    expect(evaluateAudit(r, [entry('GHSA-aaaa-bbbb-cccc', 'other')], TODAY).failures).toHaveLength(1);
  });

  it('fails a critical advisory that is not listed', () => {
    const { failures } = evaluateAudit(report(advisory('lib', 'critical', 'GHSA-cccc-dddd-eeee')), [], TODAY);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('critical');
  });

  it('moderate and low advisories are notes, never failures', () => {
    const result = evaluateAudit(
      report(advisory('a', 'moderate', 'GHSA-1111-2222-3333'), advisory('b', 'low', 'GHSA-4444-5555-6666')),
      [],
      TODAY,
    );
    expect(result.failures).toEqual([]);
    expect(result.notes.join('\n')).toContain('GHSA-1111-2222-3333');
    expect(result.notes.join('\n')).toContain('GHSA-4444-5555-6666');
  });

  it('notes an allow-list entry the report no longer has, so it can be removed', () => {
    const result = evaluateAudit(
      { auditReportVersion: 2, vulnerabilities: {} },
      [entry('GHSA-9999-8888-7777', 'x')],
      TODAY,
    );
    expect(result.failures).toEqual([]);
    expect(result.notes.join('\n')).toMatch(/GHSA-9999-8888-7777.*no longer/);
  });

  it.each([
    ['an empty id', { ...entry('', 'lib') }],
    ['a blank package', { ...entry('GHSA-aaaa-bbbb-cccc', ' ') }],
    ['an empty reason', { ...entry('GHSA-aaaa-bbbb-cccc', 'lib'), reason: '' }],
    ['a reviewBy that is not YYYY-MM-DD', entry('GHSA-aaaa-bbbb-cccc', 'lib', '31/01/2027')],
    ['a reviewBy that is no calendar day', entry('GHSA-aaaa-bbbb-cccc', 'lib', '2027-02-30')],
    ['a missing reviewBy', { id: 'GHSA-aaaa-bbbb-cccc', package: 'lib', reason: 'x' }],
  ])('a malformed entry (%s) is a failure and covers nothing', (_, bad) => {
    const { failures } = evaluateAudit(report(advisory('lib', 'high', 'GHSA-aaaa-bbbb-cccc')), [bad], TODAY);
    expect(failures.some((f) => f.includes('is invalid'))).toBe(true);
    expect(failures.some((f) => f.startsWith('not allow-listed'))).toBe(true);
  });

  it('an allow-list that is not an array is a failure', () => {
    const empty = { auditReportVersion: 2, vulnerabilities: {} };
    expect(evaluateAudit(empty, { id: 'x' }, TODAY).failures).toEqual([
      'audit-allowlist.json must be an array of entries',
    ]);
  });

  it('fails a report npm could not produce (an error body)', () => {
    expect(evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'no network' } }, [], TODAY).failures).toHaveLength(1);
  });
});
