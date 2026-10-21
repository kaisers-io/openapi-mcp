import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profiler } from 'node:inspector';
import v8Module from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import type { CoverageProviderModule, ReportContext, Vitest } from 'vitest/node';

// The v8 coverage provider, extended so lines that run only inside spawned
// `openapi-mcp` processes count (issue #86). The subprocess suites start the
// CLI from its TypeScript source; with NODE_V8_COVERAGE set, every child
// writes its raw V8 coverage to a directory when it exits, and this provider
// converts those files and merges them into the report.
//
// Why not vitest's own `coverage.autoAttachSubprocess`: it merges a child's
// raw V8 ranges with the worker's ranges for the same file URL BEFORE
// converting them (V8CoverageProvider.generateCoverage keys `mergedScripts`
// by URL). The worker ran Vite's transform of the file and the child ran
// Node's type-stripped original, so the offsets do not line up and the
// merged result is wrong: with it enabled, serve.ts dropped from 71.6% to
// 66.1% lines instead of rising. Here each child file is converted on its
// own, as Node-executed code, and only the resulting Istanbul maps are
// merged, which is a per-statement sum and therefore safe.
//
// This relies on V8CoverageProvider's private `convertCoverage`, so it is
// tied to the exactly pinned @vitest/coverage-v8 version.

// Set in the main process before the workers fork, so they inherit it;
// packages/cli/test/child-coverage.setup.ts turns it into NODE_V8_COVERAGE for
// the processes each worker spawns.
export const CHILD_COVERAGE_DIR_ENV = 'OPENAPI_MCP_CHILD_COVERAGE_DIR';

type CoverageMap = Awaited<ReturnType<V8CoverageProvider['generateCoverage']>>;

interface ScriptCoverage extends Profiler.ScriptCoverage {
  startOffset: number;
  isExtendedContext?: boolean;
}

interface Converter {
  convertCoverage: (coverage: { result: ScriptCoverage[] }) => Promise<CoverageMap>;
}

// Node writes one coverage-<pid>-<time>-<n>.json per process, listing every
// script the child ran, Node internals and node_modules included. Only file://
// scripts outside node_modules are kept (convertCoverage then applies
// coverage.include/exclude), which keeps conversion cheap. No directory means
// no child exited with coverage enabled, e.g. a run of unit tests only.
const readChildScripts = async (dir: string): Promise<ScriptCoverage[][]> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const names = entries.filter((name) => name.endsWith('.json'));
  return Promise.all(
    names.map(async (name) => {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        result: Profiler.ScriptCoverage[];
      };
      return (
        raw.result
          .filter(
            (script) => script.url.startsWith('file://') && !script.url.includes('/node_modules/'),
          )
          // Fresh objects from JSON.parse, so extending them in place is safe
          .map((script) => Object.assign(script, { startOffset: 0, isExtendedContext: true }))
      );
    }),
  );
};

class SubprocessCoverageProvider extends V8CoverageProvider {
  private childCoverageDir = '';

  override initialize(ctx: Vitest): void {
    super.initialize(ctx);
    // Under the per-run temp directory, so the base provider's clean() and
    // cleanAfterRun() remove stale child files with everything else.
    this.childCoverageDir = join(this.coverageFilesDirectory, 'subprocess');
    process.env[CHILD_COVERAGE_DIR_ENV] = this.childCoverageDir;
  }

  override async generateCoverage(context: ReportContext): Promise<CoverageMap> {
    const coverageMap = await super.generateCoverage(context);
    const converter = this as unknown as Converter;
    for (const scripts of await readChildScripts(this.childCoverageDir)) {
      // Sequential on purpose: one child's scripts at a time bounds memory;
      // convertCoverage already parallelises across the files within it.
      coverageMap.merge(await converter.convertCoverage({ result: scripts }));
    }
    return coverageMap;
  }
}

// The worker-side hooks are delegated, not copied: the v8 module keeps its
// inspector session on itself, and this file may be evaluated more than once
// per worker, while @vitest/coverage-v8 is loaded once.
const subprocessCoverageModule: CoverageProviderModule = {
  startCoverage: (options) => v8Module.startCoverage?.(options),
  takeCoverage: (options) => v8Module.takeCoverage(options),
  stopCoverage: (options) => v8Module.stopCoverage?.(options),
  getProvider: () => new SubprocessCoverageProvider(),
};

export default subprocessCoverageModule;
