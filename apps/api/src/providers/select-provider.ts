/**
 * The adapter named by `code` for the provider interface configured in env variable `envName` (CLAUDE.md §4.2).
 * The variable is required: empty stops the API at startup, naming it. Adapters are built lazily, so one that
 * refuses to load (a mock in production) only stops the API when it is the one selected; an unknown code fails at
 * startup too.
 */
export function selectProvider<T>(envName: string, code: string | undefined, factories: Record<string, () => T>): T {
  // No default: a box that forgot the variable must not quietly run on a sandbox or mock adapter.
  const wanted = code?.trim();
  const choices = Object.keys(factories).join(', ');
  if (!wanted) throw new Error(`${envName} is not set. Expected one of: ${choices}.`);
  const factory = Object.hasOwn(factories, wanted) ? factories[wanted] : undefined;
  if (!factory) throw new Error(`Unknown ${envName} "${wanted}". Expected one of: ${choices}.`);
  return factory();
}
