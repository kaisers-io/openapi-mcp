import { describe, expect, it } from 'vitest';
import {
  EXIT_ADVISORIES,
  EXIT_COVERAGE,
  EXIT_INCOMPLETE,
  EXIT_OK,
  evaluate,
  lockfileInventory,
} from './lockfile.ts';

// The pnpm 12 shape: a first document with only the package manager's own packages, then the
// project's. `shared@1.0.0` sits in both, which the auditor counts once. The git and directory
// entries are not registry packages.
const LOCKFILE = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.16.1
        version: 12.16.1

packages:

  '@pnpm/exe@12.16.1':
    resolution: {integrity: sha512-a}

  shared@1.0.0:
    resolution: {integrity: sha512-b}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      minimatch:
        specifier: 10.0.0
        version: 10.0.0

packages:

  minimatch@10.0.0:
    resolution: {integrity: sha512-c}

  brace-expansion@5.0.12:
    resolution: {integrity: sha512-d}

  shared@1.0.0:
    resolution: {integrity: sha512-b}

  local@file:local:
    resolution: {directory: local, type: directory}

  ms@git+https://example.test/ms.git#1c6264b:
    resolution: {commit: 1c6264b, repo: 'https://example.test/ms.git', type: git}
`;
// Distinct registry packages across both documents.
const PACKAGES = 4;
// What a scanner that stops at the first document would report.
const FIRST_DOCUMENT_ONLY = 2;

const severities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };

const report = (advisories: Record<string, unknown>, total = PACKAGES): string =>
  JSON.stringify({
    advisories,
    metadata: { totalDependencies: total, vulnerabilities: severities },
  });

const advisory = (severity: string): Record<string, unknown> => ({
  findings: [{ paths: ['.>minimatch>brace-expansion'], version: '5.0.11' }],
  module_name: 'brace-expansion',
  severity,
  title: 'Unbounded recursion',
  url: 'https://github.com/advisories/GHSA-0000-0000-0000',
});

const run = (stdout: string, status: number | null = 0, stderr = '') =>
  evaluate(LOCKFILE, { status, stdout, stderr });

describe('lockfileInventory', () => {
  it('counts the registry packages of every document, each once', () => {
    expect.hasAssertions();
    const inventory = lockfileInventory(LOCKFILE);
    expect([...inventory.packages].toSorted()).toStrictEqual([
      '@pnpm/exe@12.16.1',
      'brace-expansion@5.0.12',
      'minimatch@10.0.0',
      'shared@1.0.0',
    ]);
    expect(inventory.perDocument).toStrictEqual([FIRST_DOCUMENT_ONLY, 3]);
  });
});

describe('evaluate', () => {
  it('passes a clean audit that covered the lockfile', () => {
    expect.hasAssertions();
    const outcome = run(report({}));
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.errors).toStrictEqual([]);
    expect(outcome.log[0]).toBe(
      'pnpm audit covered 4 packages; pnpm-lock.yaml holds 4 registry packages (2 + 3 across 2 documents).',
    );
  });

  it('accepts a count above the floor, since pnpm also counts non-registry entries', () => {
    expect.hasAssertions();
    expect(run(report({}, PACKAGES + 1)).exitCode).toBe(EXIT_OK);
  });

  it('fails when the audit covered fewer packages than the lockfile holds', () => {
    expect.hasAssertions();
    const outcome = run(report({}, FIRST_DOCUMENT_ONLY));
    expect(outcome.exitCode).toBe(EXIT_COVERAGE);
    expect(outcome.errors).toStrictEqual([
      '::error::pnpm audit covered 2 packages; pnpm-lock.yaml holds 4 registry packages ' +
        '(2 + 3 across 2 documents). Part of the lockfile went unaudited.',
    ]);
  });

  it('fails on an advisory at high or critical and names it', () => {
    expect.hasAssertions();
    for (const severity of ['high', 'critical']) {
      const outcome = run(report({ 1: advisory(severity) }), 1);
      expect(outcome.exitCode).toBe(EXIT_ADVISORIES);
      expect(outcome.errors).toStrictEqual([
        `::error::${severity}: brace-expansion@5.0.11 Unbounded recursion https://github.com/advisories/GHSA-0000-0000-0000`,
      ]);
    }
  });

  it('passes an advisory below high, although pnpm exits 1 for it', () => {
    expect.hasAssertions();
    for (const severity of ['info', 'low', 'moderate']) {
      const outcome = run(report({ 1: advisory(severity) }), 1);
      expect(outcome.exitCode).toBe(EXIT_OK);
      expect(outcome.log[2]).toBe('advisories at high or critical, after audit.ignore: 0');
    }
  });

  // Pnpm drops an advisory listed in audit.ignore from `advisories`, still counts it in
  // `metadata.vulnerabilities`, and exits 0
  it('passes an ignored advisory that pnpm still counts in its metadata', () => {
    expect.hasAssertions();
    const ignored = JSON.stringify({
      advisories: {},
      metadata: { totalDependencies: PACKAGES, vulnerabilities: { ...severities, high: 1 } },
    });
    expect(run(ignored).exitCode).toBe(EXIT_OK);
  });

  it('calls a non-zero exit without advisories incomplete, not clean', () => {
    expect.hasAssertions();
    const outcome = run(
      report({}),
      1,
      'ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint responded with 503\n',
    );
    expect(outcome.exitCode).toBe(EXIT_INCOMPLETE);
    expect(outcome.errors).toStrictEqual([
      '::error::pnpm audit did not complete (exit 1): ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint ' +
        'responded with 503. This is not a clean result.',
    ]);
  });

  it('calls a report from a killed or failed process incomplete, whatever it holds', () => {
    expect.hasAssertions();
    const moderate = report({ 1: advisory('moderate') });
    expect(run(moderate, null).exitCode).toBe(EXIT_INCOMPLETE);
    expect(run(moderate, 2).exitCode).toBe(EXIT_INCOMPLETE);
    expect(run(report({}), null).exitCode).toBe(EXIT_INCOMPLETE);
  });

  it('calls a report that is not JSON incomplete', () => {
    expect.hasAssertions();
    expect(run('1 new vulnerabilities were ignored:\nGHSA-0000-0000-0000\n').exitCode).toBe(
      EXIT_INCOMPLETE,
    );
    expect(run('').errors).toStrictEqual([
      '::error::pnpm audit did not complete (exit 0): no output. This is not a clean result.',
    ]);
  });

  it('calls a report with an unknown severity or a missing count incomplete', () => {
    expect.hasAssertions();
    const unknown = report({ 1: advisory('severe') });
    expect(run(unknown, 1).exitCode).toBe(EXIT_INCOMPLETE);
    const noCount = JSON.stringify({ advisories: {}, metadata: { vulnerabilities: severities } });
    expect(run(noCount).exitCode).toBe(EXIT_INCOMPLETE);
  });

  it('calls a lockfile that is not valid YAML incomplete', () => {
    expect.hasAssertions();
    const outcome = evaluate('packages: [', { status: 0, stdout: report({}), stderr: '' });
    expect(outcome.exitCode).toBe(EXIT_INCOMPLETE);
    expect(outcome.errors[0]).toMatch(/^::error::pnpm-lock\.yaml is not valid YAML: /u);
  });
});
