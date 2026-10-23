import { Buffer } from 'node:buffer';

// The client-authentication half of the client-credentials grant, kept free
// of the transport: the CLI's option parsing uses it at registration time,
// and importing oauth-client-credentials.ts there would load the pinned
// dispatcher (and undici) for every command, not only `serve` (issue
// kaisers-io/openapi-mcp-archive#91).

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

// RFC 6749 §2.3.1: the client id and secret are each encoded with the
// application/x-www-form-urlencoded algorithm (Appendix B) BEFORE being
// joined with ":" and Base64-encoded for HTTP Basic.
const formEncode = (value: string): string =>
  new URLSearchParams([['', value]]).toString().slice(1);

export const clientSecretBasic = (clientId: string, clientSecret: string): string =>
  `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, 'utf8').toString('base64')}`;
