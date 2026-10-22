// Fixture for coverage-subprocess.test.ts: type annotations make Vite's
// transform and Node's type stripping place the code at different offsets,
// which is what made the worker's and the child's coverage disagree.
type Pair = { left: number; right: number };

// Runs in the vitest worker AND in the Node child
export const sum = (pair: Pair): number => pair.left + pair.right;

// Runs only in the worker
export const double = (value: number): number => value * 2;

// Runs only in the child
export const shout = (text: string): string => `${text.toUpperCase()}!`;

// Never runs
export const negate = (flag: boolean): boolean => !flag;
