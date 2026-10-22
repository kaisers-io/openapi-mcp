// Run by Node directly (type stripping), as the CLI E2E suites run the CLI
import { shout, sum } from './typed.ts';

process.stdout.write(`${String(sum({ left: 1, right: 2 }))} ${shout('ok')}\n`);
