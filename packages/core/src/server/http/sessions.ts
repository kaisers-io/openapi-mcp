type Session<T> = {
  value: T;
  lastSeenMs: number;
};

export type SessionStoreOptions = {
  maxSessions: number;
  idleMs: number;
};

export type SessionStore<T> = {
  create: (id: string, value: T, nowMs: number) => { ok: true } | { ok: false; reason: 'capacity' };
  get: (id: string, nowMs: number) => T | undefined;
  touch: (id: string, nowMs: number) => void;
  remove: (id: string) => void;
  // Evicts every session idle past idleMs and returns their VALUES (not
  // ids): a caller needs the actual resource (e.g. a transport) to release
  // it, not merely a name — this is what lets the wiring below actually
  // CLOSE an expired session's transport, not just stop counting it.
  sweepExpired: (nowMs: number) => readonly T[];
  // Every currently-stored value, unconditionally, WITHOUT evicting
  // anything — used for a graceful-shutdown drain where every session's
  // transport must be closed regardless of idle state.
  values: () => readonly T[];
  size: () => number;
};

// Pure, in-memory, injected-clock session bookkeeping — decoupled from the
// SDK transport entirely so it is unit-testable without any HTTP machinery.
export const createSessionStore = <T>(opts: SessionStoreOptions): SessionStore<T> => {
  const sessions = new Map<string, Session<T>>();
  const isExpired = (session: Session<T>, nowMs: number): boolean =>
    nowMs - session.lastSeenMs > opts.idleMs;
  return {
    create: (id, value, nowMs) => {
      if (sessions.size >= opts.maxSessions) {
        return { ok: false, reason: 'capacity' };
      }
      sessions.set(id, { value, lastSeenMs: nowMs });
      return { ok: true };
    },
    get: (id, nowMs) => {
      const session = sessions.get(id);
      return session === undefined || isExpired(session, nowMs) ? undefined : session.value;
    },
    touch: (id, nowMs) => {
      const session = sessions.get(id);
      if (session !== undefined) {
        session.lastSeenMs = nowMs;
      }
    },
    remove: (id) => {
      sessions.delete(id);
    },
    sweepExpired: (nowMs) => {
      const expiredIds: string[] = [];
      const expiredValues: T[] = [];
      for (const [id, session] of sessions) {
        if (isExpired(session, nowMs)) {
          expiredIds.push(id);
          expiredValues.push(session.value);
        }
      }
      for (const id of expiredIds) {
        sessions.delete(id);
      }
      return expiredValues;
    },
    values: () => [...sessions.values()].map((session) => session.value),
    size: () => sessions.size,
  };
};
