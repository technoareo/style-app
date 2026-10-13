import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped record of "the database was too busy to start this work".
 *
 * Better Auth turns any thrown database error into a generic 500. The auth
 * dialect calls noteContention() when lock acquisition for a transaction (or
 * an autocommit statement) is exhausted, which means the work NEVER STARTED:
 * no statement of that transaction ran, so nothing was written and no token
 * was consumed. The public auth route uses the flag to answer a truthful,
 * retryable 503 with Retry-After instead of an opaque 500.
 *
 * The scope is an AsyncLocalStorage store, so concurrent requests cannot
 * mislabel each other.
 */

type Scope = { contended: boolean; where?: string };
const scope = new AsyncLocalStorage<Scope>();

export function noteContention(where: string): void {
  const store = scope.getStore();
  if (store) {
    store.contended = true;
    store.where ??= where;
  }
}

export async function runWithContention<T>(
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; contended: boolean; where?: string }> {
  const store: Scope = { contended: false };
  try {
    const value = await scope.run(store, fn);
    return { value, contended: store.contended, where: store.where };
  } catch (error) {
    return { error, contended: store.contended, where: store.where };
  }
}
