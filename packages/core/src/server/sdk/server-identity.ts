import type { Redactor } from '../../redact.ts';
import { someDecodedForm } from '../withheld.ts';

// A throw while scanning counts as a find, as everywhere else
const titleHasSecret = (redactor: Redactor, title: string): boolean => {
  try {
    return (
      redactor.scanForSecret(title) ||
      someDecodedForm(title, (form) => redactor.scanForSecret(form))
    );
  } catch {
    return true;
  }
};

// The serverInfo a session sends. The title is spec or operator text, and
// the SDK sends it in the initialize result and stamps it on every later
// result. It reads this object each time, so the getter checks the title
// against the redactor on every send: a secret registered at runtime, such
// as a value read from a --header-file, withholds the title from then on,
// and it stays withheld. An empty title is never sent.
export const serverIdentity = (identity: {
  name: string;
  version: string;
  title: string;
  redactor: Redactor;
}): { name: string; version: string; title?: string } => {
  const { name, version, title, redactor } = identity;
  if (title === '') {
    return { name, version };
  }
  let withheld = false;
  // A withheld title reads as undefined, which JSON leaves out, so the
  // client sees no title at all; the declared type cannot say "absent later"
  return {
    name,
    version,
    get title() {
      withheld ||= titleHasSecret(redactor, title);
      return withheld ? undefined : title;
    },
  } as { name: string; version: string; title?: string };
};
