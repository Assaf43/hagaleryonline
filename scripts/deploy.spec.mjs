import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
if (!hasBash) console.warn('deploy.spec: bash not found on PATH, specs skipped');

let dir, bin, stateDir, logFile, envFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-spec-')).replaceAll('\\', '/');
  bin = `${dir}/bin`;
  stateDir = `${dir}/state`;
  logFile = `${dir}/docker.log`;
  mkdirSync(bin);
  copyFileSync(join(root, 'scripts/fixtures/fake-docker.sh'), `${bin}/docker`);
  chmodSync(`${bin}/docker`, 0o755);
  envFile = `${dir}/env.prod`;
  writeFileSync(envFile, 'APP_ENV=staging\n');
  writeFileSync(logFile, '');
});

const setState = (current, previous) => {
  mkdirSync(stateDir, { recursive: true });
  if (current) writeFileSync(`${stateDir}/current`, `${current}\n`);
  if (previous) writeFileSync(`${stateDir}/previous`, `${previous}\n`);
};
const state = (name) => (existsSync(`${stateDir}/${name}`) ? readFileSync(`${stateDir}/${name}`, 'utf8').trim() : null);
const calls = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
const run = (script, args = [], env = {}) => {
  const r = spawnSync('bash', [`${root}/deploy/${script}`, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logFile,
      DEPLOY_STATE_DIR: stateDir,
      DEPLOY_ENV_FILE: envFile,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const idx = (list, re) => list.findIndex((l) => re.test(l));

describe.skipIf(!hasBash)('deploy scripts', () => {
  it('refuses an empty tag', () => {
    const r = run('deploy.sh', ['']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Usage');
    expect(calls()).toEqual([]);
    expect(run('deploy.sh', ['bad tag!']).code).not.toBe(0);
  });

  it('success swaps state and runs infra, setup, migrate, up in order', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], {
      DEPLOY_INFRA_SERVICES: 'postgres minio',
      DEPLOY_SETUP_SERVICES: 'minio-setup',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Deployed v2 (previous v1)');
    expect(state('current')).toBe('v2');
    expect(state('previous')).toBe('v1');
    const c = calls();
    const order = [
      idx(c, /image inspect nesto-app:v2/),
      idx(c, / run --rm -i .*nesto-app:v2 node - \/env \/compose\.yml/),
      idx(c, /up -d --wait postgres minio/),
      idx(c, /run --rm minio-setup/),
      idx(c, /--profile deploy run --rm migrate/),
      idx(c, /^IMAGE_TAG=v2 .*up -d --no-deps --wait/),
    ];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('step 0: refuses without an env file, before any docker call', () => {
    for (const env of [
      { DEPLOY_ENV_FILE: '' },
      { DEPLOY_ENV_FILE: '', DEPLOY_COMPOSE_ARGS: '-f docker-compose.prod.yml' },
    ]) {
      const r = run('deploy.sh', ['v2'], env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('No env file: set DEPLOY_ENV_FILE or pass --env-file in DEPLOY_COMPOSE_ARGS');
    }
    const several = run('deploy.sh', ['v2'], {
      DEPLOY_ENV_FILE: '',
      DEPLOY_COMPOSE_ARGS: `-f docker-compose.prod.yml --env-file ${envFile} --env-file=${envFile}`,
    });
    expect(several.code).toBe(1);
    expect(several.out).toContain('several --env-file');
    const gone = run('deploy.sh', ['v2'], { DEPLOY_ENV_FILE: `${dir}/missing.env` });
    expect(gone.code).toBe(1);
    expect(gone.out).toContain('Env file not found');
    expect(calls()).toEqual([]);
  });

  it('step 0: the env file defaults to the --env-file of DEPLOY_COMPOSE_ARGS', () => {
    for (const flag of [`--env-file ${envFile}`, `--env-file=${envFile}`]) {
      writeFileSync(logFile, '');
      const r = run('deploy.sh', ['v2'], {
        DEPLOY_ENV_FILE: '',
        DEPLOY_COMPOSE_ARGS: `-p nesto-x -f docker-compose.prod.yml ${flag}`,
      });
      expect(r.code, r.out).toBe(0);
      const check = calls().find((l) => / run --rm -i /.test(l));
      expect(check).toContain(`-v ${envFile}:/env:ro`);
      expect(check).toContain(`-v ${root}/docker-compose.prod.yml:/compose.yml:ro`);
      expect(check).toContain('--network none');
      expect(check).toContain('--pull never');
    }
  });

  it('a failed env check changes nothing', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], { FAKE_FAIL: 'check-env' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('The env file failed the checks above; still running v1');
    expect(calls().some((l) => / up /.test(l) || l.includes('migrate'))).toBe(false);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v0']);
  });

  it('migrate failure keeps old', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], { FAKE_FAIL: 'migrate' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Migration failed; still running v1');
    expect(calls().some((l) => l.includes('--no-deps'))).toBe(false);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v0']);
  });

  it('infra failure keeps old', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], { FAKE_FAIL: 'infra' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Infrastructure failed; still running v1');
    expect(calls().some((l) => l.includes('migrate') || l.includes('--no-deps'))).toBe(false);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v0']);
  });

  it('missing images call nothing else and keep state', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], { FAKE_FAIL: 'image' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Still running v1');
    expect(calls()).toHaveLength(1);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v0']);
  });

  it('refuses while another deploy holds the lock', () => {
    setState('v1', 'v0');
    mkdirSync(`${stateDir}/.lock`);
    const r = run('deploy.sh', ['v2']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Another deploy');
    expect(calls()).toEqual([]);
    expect(existsSync(`${stateDir}/.lock`)).toBe(true);
  });

  it('releases the lock after a run', () => {
    run('deploy.sh', ['v1']);
    expect(existsSync(`${stateDir}/.lock`)).toBe(false);
  });

  it('unhealthy rolls back', () => {
    setState('v1', 'v0');
    const r = run('deploy.sh', ['v2'], { FAKE_FAIL: 'up', FAKE_FAIL_TAG: 'v2' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Health check failed; back on v1');
    const all = calls();
    const migrates = all.filter((l) => /run --rm migrate/.test(l));
    expect(migrates).toHaveLength(1);
    expect(all.indexOf(migrates[0])).toBeLessThan(all.findIndex((l) => l.includes('--no-deps')));
    const ups = all.filter((l) => l.includes('--no-deps'));
    expect(ups).toHaveLength(2);
    expect(ups[0]).toMatch(/^IMAGE_TAG=v2 /);
    expect(ups[1]).toMatch(/^IMAGE_TAG=v1 /);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v0']);
  });

  it('first deploy health failure exits 1 without rollback', () => {
    const r = run('deploy.sh', ['v1'], { FAKE_FAIL: 'up', FAKE_FAIL_TAG: 'v1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Health check failed; no previous version');
    expect(calls().filter((l) => l.includes('--no-deps'))).toHaveLength(1);
    expect(state('current')).toBeNull();
  });

  it('rollback uses previous without migrate', () => {
    setState('v2', 'v1');
    const r = run('rollback.sh');
    expect(r.code).toBe(0);
    const c = calls();
    expect(c.some((l) => l.includes('migrate'))).toBe(false);
    expect(c.some((l) => /^IMAGE_TAG=v1 .*up -d --no-deps --wait/.test(l))).toBe(true);
    expect([state('current'), state('previous')]).toEqual(['v1', 'v2']);
  });

  it('rollback with no previous refuses', () => {
    setState('v1', null);
    const r = run('rollback.sh');
    expect(r.code).toBe(1);
    expect(r.out).toContain('No previous version');
    expect(calls()).toEqual([]);
  });
});
