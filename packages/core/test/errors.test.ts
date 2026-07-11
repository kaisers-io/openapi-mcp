import { describe, expect, it } from 'vitest';
import {
  EXIT,
  OpenapiMcpError,
  conflictError,
  notFoundError,
  renderError,
  usageError,
  validationError,
} from '../src/index.ts';

describe('EXIT map', () => {
  it('defines the spec exit codes', () => {
    expect(EXIT).toEqual({
      OK: 0,
      UNEXPECTED: 1,
      USAGE: 2,
      VALIDATION: 3,
      NOT_FOUND: 4,
      CONFLICT: 5,
    });
  });
});

describe('error factories', () => {
  it.each([
    [usageError, 'usage', EXIT.USAGE],
    [validationError, 'validation', EXIT.VALIDATION],
    [notFoundError, 'not_found', EXIT.NOT_FOUND],
    [conflictError, 'conflict', EXIT.CONFLICT],
  ])('%o creates a typed error', (factory, code, exitCode) => {
    const err = factory('boom');
    expect(err).toBeInstanceOf(OpenapiMcpError);
    expect(err.code).toBe(code);
    expect(err.exitCode).toBe(exitCode);
    expect(err.message).toBe('boom');
  });
});

describe('renderError', () => {
  it('renders a typed error without stack by default', () => {
    const rendered = renderError(usageError('bad flag'), { verbose: false });
    expect(rendered).toEqual({ code: 'usage', exitCode: EXIT.USAGE, message: 'bad flag' });
  });

  it('includes the stack when verbose', () => {
    const rendered = renderError(validationError('nope'), { verbose: true });
    expect(rendered.stack).toContain('errors.test.ts');
  });

  it('includes the stack of a plain Error when verbose', () => {
    const rendered = renderError(new Error('plain'), { verbose: true });
    expect(rendered.stack).toContain('errors.test.ts');
  });

  it('maps unknown throwables to unexpected', () => {
    const rendered = renderError('plain string', { verbose: false });
    expect(rendered).toEqual({
      code: 'unexpected',
      exitCode: EXIT.UNEXPECTED,
      message: 'plain string',
    });
  });

  it('maps plain Error to unexpected with its message', () => {
    const rendered = renderError(new Error('kaputt'), { verbose: false });
    expect(rendered.code).toBe('unexpected');
    expect(rendered.exitCode).toBe(EXIT.UNEXPECTED);
    expect(rendered.message).toBe('kaputt');
  });
});
