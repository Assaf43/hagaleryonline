/**
 * `APP_ENV` (only read under `NODE_ENV=production`): `production` (the default) or `staging`. Staging is a production
 * build with every secret / URL rule of `checkProductionEnv`, but the mock e-mail / SMS / invoice / marketing providers
 * and the payment sandbox may run (the local rehearsal and the staging server). Any other value is refused at startup.
 */
export const APP_ENVS = ['production', 'staging'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** A plain env record (`process.env`) or a `ConfigService`. */
export type EnvSource = Record<string, string | undefined> | { get(key: string): unknown };

function read(env: EnvSource, key: string): string {
  const value =
    'get' in env && typeof env.get === 'function'
      ? (env as { get(key: string): unknown }).get(key)
      : (env as Record<string, string | undefined>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The only place the mock providers (e-mail, SMS, invoices, marketing) and the payment sandbox ask whether they may
 * load: always outside `NODE_ENV=production`, and in production only with `APP_ENV=staging`.
 */
export function allowsMockProviders(env: EnvSource): boolean {
  if (read(env, 'NODE_ENV') !== 'production') return true;
  return read(env, 'APP_ENV') === 'staging';
}
