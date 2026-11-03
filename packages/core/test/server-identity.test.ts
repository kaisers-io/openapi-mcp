import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/index.ts';
import { serverIdentity } from '../src/server/sdk/server-identity.ts';

const SECRET = 'example-token-not-a-secret';

const identity = (title: string, redactor = createRedactor([])) =>
  serverIdentity({ name: 'openapi-mcp', version: '1.0.0', title, redactor });

// What the SDK sends: the JSON text of the object it was given
const sent = (value: object): unknown => {
  const text = JSON.stringify(value);
  return JSON.parse(text);
};

describe('serverIdentity', () => {
  it('sends the title when it holds no registered secret', () => {
    expect(sent(identity('Example API (dev)'))).toEqual({
      name: 'openapi-mcp',
      version: '1.0.0',
      title: 'Example API (dev)',
    });
  });

  it('sends no title for an empty one', () => {
    expect(sent(identity(''))).toEqual({ name: 'openapi-mcp', version: '1.0.0' });
  });

  it('withholds a title that holds a secret registered at startup', () => {
    const info = identity(`Example ${SECRET}`, createRedactor([SECRET]));
    expect(sent(info)).toEqual({
      name: 'openapi-mcp',
      version: '1.0.0',
    });
  });

  it('withholds a title that holds an entity-escaped secret', () => {
    const redactor = createRedactor(['example&token-not-a-secret']);
    expect(sent(identity('Example example&amp;token-not-a-secret', redactor))).toEqual({
      name: 'openapi-mcp',
      version: '1.0.0',
    });
  });

  it('withholds the title from the first send after a secret is registered at runtime, and keeps it withheld', () => {
    const redactor = createRedactor([]);
    const info = identity(`Example ${SECRET}`, redactor);
    expect(sent(info)).toHaveProperty('title', `Example ${SECRET}`);
    redactor.registerRuntimeSecret(SECRET, Number.POSITIVE_INFINITY, 0);
    expect(sent(info)).not.toHaveProperty('title');
    redactor.retireRuntimeSecret(SECRET);
    expect(sent(info)).not.toHaveProperty('title');
  });

  it('withholds the title when scanning throws', () => {
    const throwing = {
      ...createRedactor([]),
      scanForSecret: () => {
        throw new Error('scan failed');
      },
    };
    expect(sent(identity('Example API', throwing))).not.toHaveProperty('title');
  });
});
