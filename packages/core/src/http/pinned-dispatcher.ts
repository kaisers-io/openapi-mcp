import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { classifyAddress } from './egress.ts';

// M5 Task 3 (design §2.1-2.3, D1): the SSRF connection-pinning core. undici's
// custom connect.lookup resolves the hostname exactly once via the injected
// `resolve`, validates EVERY answer with the hardened classifyAddress (Task
// 1) BEFORE any socket is opened, and connects only to the validated IPs —
// so there is a single DNS resolution per connection and no separate
// "validate, then resolve again" TOCTOU window. undici preserves the
// original Host header and TLS SNI/cert against the hostname regardless of
// which IP the lookup callback selects (probe-confirmed:
// _local/research/m5-egress-probe-node2412.md). A plain Agent with a custom
// `connect` never consults HTTP(S)_PROXY — there is no proxy-dispatch code
// path for it to reach.
//
// Task 4's amendment note: Node skips `lookup` entirely for an IP-literal
// hostname, so this Agent alone does not protect a hop whose URL is already
// an IP literal (e.g. a redirect to 127.0.0.1 or 169.254.169.254) — that
// synchronous per-hop check is pinnedRequest's job (Task 4).

export interface PinnedPolicy {
  allowPrivateNetwork: boolean;
  // Hop 0 from --base-url: skip the private-address deny (metadata is still
  // always denied). A redirect hop (Task 4) is never trusted.
  trusted: boolean;
}

// Bound to the call's abort signal by the caller (Task 4's pinnedRequest).
export type Resolve = (hostname: string) => Promise<readonly string[]>;

// Bounds the cost of validating a hostile/misconfigured resolver's answer
// set, and the size of the address array handed to undici's connector.
export const MAX_DNS_ANSWERS = 32;

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

// Exported so the lookup contract's edge cases (the options.all fallback,
// the callback-once latch, and the sync-throw wrapping) can be unit-tested
// directly — undici's own connector always calls back with options.all ===
// true, so the fallback branch below is otherwise unreachable through a real
// fetch.
export const pinnedLookup =
  (policy: PinnedPolicy, resolve: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    // A callback-once latch (round-1 amendment): the lookup contract
    // is a single callback invocation; guard defensively so a misbehaving
    // `resolve` cannot cause a double-invocation even if it violated the
    // Promise spec's own single-settlement guarantee.
    let done = false;
    const finish: typeof callback = (err, address, family) => {
      if (done) {
        return;
      }
      done = true;
      callback(err, address, family);
    };
    // Wrapped in Promise.resolve().then(...) (round-1 amendment) so a
    // SYNCHRONOUS throw inside `resolve` still reaches the .catch below
    // instead of leaving the callback — and the request — hanging.
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((addresses) => {
        if (addresses.length === 0) {
          return finish(new Error(`egress: "${hostname}" did not resolve to any address`), []);
        }
        if (addresses.length > MAX_DNS_ANSWERS) {
          return finish(new Error(`egress: "${hostname}" returned too many DNS answers`), []);
        }
        for (const address of addresses) {
          if (isIP(address) === 0) {
            return finish(new Error(`egress: "${hostname}" returned a non-IP answer`), []);
          }
          const classification = classifyAddress(address);
          if (classification === 'metadata') {
            return finish(
              new Error(`egress: "${hostname}" resolves to a cloud-metadata address`),
              [],
            );
          }
          if (classification === 'private' && !(policy.trusted || policy.allowPrivateNetwork)) {
            return finish(
              new Error(`egress: "${hostname}" resolves to a private/loopback address`),
              [],
            );
          }
        }
        // The array-callback form is valid only when options.all === true
        // (round-1 amendment: do not ignore `options`). Node/undici's
        // connector always requests it that way (probe-confirmed), but a
        // defensive single-address fallback keeps the contract honest.
        if (options.all === true) {
          return finish(
            null,
            addresses.map((address) => ({ address, family: isIP(address) })),
          );
        }
        const [first] = addresses;
        // Unreachable via undici in practice (it always passes all:true);
        // kept total per the lookup contract's non-`all` form.
        return finish(null, first ?? '', first === undefined ? undefined : isIP(first));
      })
      .catch((err: unknown) => finish(asError(err), []));
  };

export const createPinnedAgent = (policy: PinnedPolicy, resolve: Resolve): Agent =>
  new Agent({ connect: { lookup: pinnedLookup(policy, resolve) } });
