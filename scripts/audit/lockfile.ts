// The checks behind `node scripts/audit/run.ts`, kept free of I/O so the tests can drive every
// outcome without a registry.
//
// Why this exists. Since pnpm 12, `pnpm-lock.yaml` holds two YAML documents: the first carries only
// the package manager's own install graph, the second everything the project depends on. A tool
// that reads only the first document reports a project with almost no dependencies and no
// vulnerabilities, and does not fail. GitHub's dependency graph reads this repository's lockfile
// that way: its SBOM lists the pnpm platform binaries and the direct dependencies, and nothing
// transitive, so Dependabot alerts do not cover the transitive packages bundled into the CLI.
// `pnpm audit` reads both documents, which makes it the only scanner for the shipped code.
//
// "Reads both documents" is checked, not assumed. The distinct registry packages in every
// document, counted here independently with a real YAML parser, set a floor that the audit's
// reported package count must reach. Should a future pnpm, or a lockfile split into a third
// document, leave a document unaudited, the audit reports fewer and this fails instead of passing
// over a partial inventory. The check is a floor, not an equality: pnpm audit skips git and
// directory packages (no npm advisory can name them) and counts some non-registry entries, so only
// the registry packages are a number both sides agree must be covered.
//
// What the floor does not prove: that each package identity was audited. It compares two counts,
// and pnpm reports no list of what it sent. An audit that skipped some registry packages while
// counting as many other entries would pass. It catches a whole document left out, and nothing
// finer.
//
// Exit codes keep the three failures apart, because they call for different responses:
//   0  the audit covered the lockfile, and no advisory at high or critical remains
//      (advisories listed in `audit.ignore` in pnpm-workspace.yaml do not count)
//   1  advisories at high or critical
//   2  the audit reported fewer packages than the lockfile's registry packages
//   3  the audit did not complete (registry or network error, or a report this script cannot
//      read, such as an unknown severity): NOT a clean result, run it again
import { parseAllDocuments } from 'yaml';

export const EXIT_OK = 0;
export const EXIT_ADVISORIES = 1;
export const EXIT_COVERAGE = 2;
export const EXIT_INCOMPLETE = 3;

// The threshold of the playbook in CONTRIBUTING.md ("Dependency audit"): low and moderate are
// reported but do not fail the run.
const FAILING_SEVERITIES = new Set(['high', 'critical']);
// Every severity pnpm reports. Anything else is a report this script cannot read, not a pass.
const KNOWN_SEVERITIES = new Set(['info', 'low', 'moderate', ...FAILING_SEVERITIES]);
// Lines of pnpm's own error output quoted when the audit did not complete.
const DETAIL_LINES = 5;

export interface AuditRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Outcome {
  exitCode: number;
  log: string[];
  errors: string[];
}

interface Advisory {
  severity: string;
  module_name?: string;
  title?: string;
  url?: string;
  findings?: { version?: string }[];
}

interface Report {
  metadata: { totalDependencies: number; vulnerabilities: Record<string, unknown> };
  advisories: Record<string, Advisory>;
}

interface Inventory {
  packages: Set<string>;
  perDocument: number[];
}

class AuditFailureError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'AuditFailureError';
    this.exitCode = exitCode;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A registry package's resolution is its integrity hash alone. Git, directory, tarball-URL and
// runtime entries carry more (`type`, `tarball`, `commit`) and stay out of the floor.
const isRegistryPackage = (entry: unknown): boolean => {
  const resolution = isRecord(entry) ? entry['resolution'] : undefined;
  const keys = isRecord(resolution) ? Object.keys(resolution) : [];
  return keys.length === 1 && keys[0] === 'integrity';
};

// Distinct registry package keys (`name@version`) across every document. A key in more than one
// document is one package to the auditor too, so it counts once.
export const lockfileInventory = (text: string): Inventory => {
  const perDocument = parseAllDocuments(text).map((document) => {
    const [first] = document.errors;
    if (first !== undefined) {
      throw new AuditFailureError(
        `pnpm-lock.yaml is not valid YAML: ${first.message}`,
        EXIT_INCOMPLETE,
      );
    }
    const root: unknown = document.toJS();
    const packages = isRecord(root) && isRecord(root['packages']) ? root['packages'] : {};
    return Object.entries(packages)
      .filter(([, entry]) => isRegistryPackage(entry))
      .map(([key]) => key);
  });
  return {
    packages: new Set(perDocument.flat()),
    perDocument: perDocument.map((keys) => keys.length),
  };
};

// The shape every later step relies on. A filter that skipped an advisory it could not classify
// would turn an unreadable report into a clean one, so an unknown severity rejects the whole
// report.
const isReport = (value: unknown): value is Report => {
  if (!isRecord(value) || !isRecord(value['metadata']) || !isRecord(value['advisories'])) {
    return false;
  }
  const total = value['metadata']['totalDependencies'];
  return (
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    isRecord(value['metadata']['vulnerabilities']) &&
    Object.values(value['advisories']).every(
      (advisory) =>
        isRecord(advisory) &&
        typeof advisory['severity'] === 'string' &&
        KNOWN_SEVERITIES.has(advisory['severity']),
    )
  );
};

// Read from `advisories`, not `metadata.vulnerabilities`: pnpm 12.16 drops the advisories listed
// in `audit.ignore` from the first, but still counts them in the second. Counting metadata would
// keep the run red over an advisory the maintainers accepted, with no advisory left to name.
const failingAdvisories = (report: Report): Advisory[] =>
  Object.values(report.advisories).filter((advisory) => FAILING_SEVERITIES.has(advisory.severity));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: parseReport calls the audit incomplete.
    return undefined;
  }
};

const firstLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, DETAIL_LINES)
    .join(' | ');

// The audit's JSON, or a failure that says the audit did not finish. pnpm exits 0 for a clean
// report and 1 for an advisory at any severity, so exit 1 is a result only when the report names an
// advisory: with no advisory it is a transport error dressed as a result. Any other status,
// including none (the process was killed), means the audit did not finish, whatever it printed.
const completed = (status: number | null, report: Report): boolean =>
  status === 0 || (status === 1 && Object.keys(report.advisories).length > 0);

const parseReport = ({ status, stdout, stderr }: AuditRun): Report => {
  const report = parseJson(stdout);
  if (!isReport(report) || !completed(status, report)) {
    const detail = firstLines(stderr || stdout) || 'no output';
    throw new AuditFailureError(
      `pnpm audit did not complete (exit ${String(status)}): ${detail}. This is not a clean result.`,
      EXIT_INCOMPLETE,
    );
  }
  return report;
};

// "15 + 212 across 2 documents"; a lockfile from before pnpm 12 is "211 in 1 document".
const describeDocuments = ({ perDocument }: Inventory): string =>
  perDocument.length === 1
    ? `${String(perDocument[0])} in 1 document`
    : `${perDocument.join(' + ')} across ${String(perDocument.length)} documents`;

const describeAdvisory = (advisory: Advisory): string => {
  const versions = [...new Set((advisory.findings ?? []).map((finding) => finding.version))];
  const at = versions.length > 0 ? `@${versions.join(',')}` : '';
  const name = advisory.module_name ?? 'unknown package';
  return `${advisory.severity}: ${name}${at} ${advisory.title ?? ''} ${advisory.url ?? ''}`.trim();
};

const evaluateOrThrow = (lockfile: string, run: AuditRun): Outcome => {
  const inventory = lockfileInventory(lockfile);
  const report = parseReport(run);
  const audited = report.metadata.totalDependencies;
  const coverage =
    `pnpm audit covered ${String(audited)} packages; pnpm-lock.yaml holds ` +
    `${String(inventory.packages.size)} registry packages (${describeDocuments(inventory)})`;
  // A count floor, not an identity check: see the header for what it can and cannot catch.
  if (audited < inventory.packages.size) {
    throw new AuditFailureError(`${coverage}. Part of the lockfile went unaudited.`, EXIT_COVERAGE);
  }
  const failing = failingAdvisories(report);
  return {
    exitCode: failing.length > 0 ? EXIT_ADVISORIES : EXIT_OK,
    log: [
      `${coverage}.`,
      `pnpm metadata by severity, ignored advisories included: ${JSON.stringify(report.metadata.vulnerabilities)}`,
      `advisories at high or critical, after audit.ignore: ${String(failing.length)}`,
    ],
    errors: failing.map((advisory) => `::error::${describeAdvisory(advisory)}`),
  };
};

// Anything unforeseen is still a failure to look at, never a pass.
export const evaluate = (lockfile: string, run: AuditRun): Outcome => {
  try {
    return evaluateOrThrow(lockfile, run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof AuditFailureError ? error.exitCode : EXIT_INCOMPLETE;
    return { exitCode, log: [], errors: [`::error::${message}`] };
  }
};
