import type { Option } from '@commander-js/extra-typings';

// Facts about options that commander's own metadata does not carry, declared
// where the options are defined so `--json help` (issue #75) and the parser
// read the same source.

// The one accumulator of every repeatable option: `--json help` reports an
// option as repeatable exactly when it parses with this function.
export const collect = (
  value: string,
  previous: readonly string[] | undefined,
): readonly string[] => [...(previous ?? []), value];

// Records the values an option accepts when the CLI checks them itself (with
// its own error message) rather than through commander's `.choices()`. Only
// `--json help` and the help text read it; parsing is unchanged.
export const declareChoices = (
  command: { readonly options: readonly Option[] },
  long: string,
  choices: readonly string[],
): void => {
  const option = command.options.find((candidate) => candidate.long === long);
  if (option === undefined) {
    throw new Error(`no option ${long} to declare choices for`);
  }
  option.argChoices = [...choices];
};
