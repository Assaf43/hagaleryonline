/**
 * The backup tool of the `backup` container (spec 9b.5, NFR-09; how to run it: deploy/backup/README.md):
 *
 *   node apps/api/dist/backup/main.js daemon     db, then media, every day at BACKUP_AT (Israel time); stops on SIGTERM
 *   node apps/api/dist/backup/main.js db         one encrypted database dump now
 *   node apps/api/dist/backup/main.js media      one encrypted copy of the new photos now
 *   node apps/api/dist/backup/main.js restore-db --object <key> --identity <file> --target-db <name> [--keep]
 *   node apps/api/dist/backup/main.js restore-media --identity <file> [--prefix <p>]
 *
 * Settings come from the environment only (never argv). Output is one scrubbed JSON line per event; exit code 1 when
 * a run or a restore check failed, 2 for a usage error.
 */
import { parseArgs } from 'node:util';
import { failureDetail, logLine, type Env } from './backup-common.js';
import { dbBackupConfig, runDbBackup, type BackupResult } from './backup-db.js';
import { mediaBackupConfig, runMediaBackup } from './backup-media.js';
import { restoreDb, restoreMedia } from './restore.js';
import { nextRun, parseAt } from './schedule.js';

const USAGE = `Usage: node apps/api/dist/backup/main.js <command>
  daemon                       run db, then media, daily at BACKUP_AT (Israel time, default 02:30)
  db                           encrypted database dump to the backup bucket
  media                        encrypted copy of new photos to the backup bucket
  restore-db --object <key> --identity <file> --target-db <name> [--keep]
  restore-media --identity <file> [--prefix <p>]
Settings: environment only (see deploy/backup/README.md).`;

const MAX_TIMEOUT = 2_147_483_647;

function sleepUntil(when: Date, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const tick = () => {
      const left = when.getTime() - Date.now();
      if (left <= 0 || signal.aborted) return done();
      timer = setTimeout(tick, Math.min(left, MAX_TIMEOUT));
    };
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    tick();
  });
}

function logRun(kind: 'db' | 'media', result: BackupResult): void {
  if (result.ok)
    logLine('log', `${kind} backup done`, { run: result.runId, bytes: result.bytes, objects: result.objects });
  else logLine('error', `${kind} backup failed`, { run: result.runId, detail: result.detail });
}

async function once(kind: 'db' | 'media', env: Env, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = kind === 'db' ? await runDbBackup(env, { signal }) : await runMediaBackup(env, { signal });
    logRun(kind, result);
    return result.ok;
  } catch (error) {
    // Before a row could be written (a setting, the database down): the 26-hour "missing backup" alert covers it.
    logLine('error', `${kind} backup could not start`, { detail: failureDetail(error) });
    return false;
  }
}

async function daemon(env: Env): Promise<void> {
  const at = env.BACKUP_AT || '02:30';
  parseAt(at);
  dbBackupConfig(env);
  mediaBackupConfig(env);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  logLine('log', 'backup daemon started', { at });
  while (!stop.signal.aborted) {
    const next = nextRun(new Date(), at);
    logLine('log', 'next backup run', { next: next.toISOString() });
    await sleepUntil(next, stop.signal);
    if (stop.signal.aborted) break;
    await once('db', env, stop.signal);
    if (stop.signal.aborted) break;
    await once('media', env, stop.signal);
  }
  logLine('log', 'backup daemon stopped');
}

export async function main(argv: string[], env: Env): Promise<number> {
  const [command, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: rest,
      strict: true,
      options: {
        object: { type: 'string' },
        identity: { type: 'string' },
        'target-db': { type: 'string' },
        keep: { type: 'boolean' },
        prefix: { type: 'string' },
        help: { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    process.stderr.write(`${failureDetail(error)}\n${USAGE}\n`);
    return 2;
  }
  if (!command || command === '--help' || command === 'help' || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }

  try {
    switch (command) {
      case 'daemon':
        await daemon(env);
        return 0;
      case 'db':
      case 'media':
        return (await once(command, env)) ? 0 : 1;
      case 'restore-db': {
        if (!values.object || !values.identity || !values['target-db']) break;
        const result = await restoreDb(env, {
          object: values.object as string,
          identity: values.identity as string,
          targetDb: values['target-db'] as string,
          keep: values.keep === true,
        });
        for (const line of result.mismatches) logLine('error', 'row count mismatch', { table: line });
        if (result.ok) logLine('log', 'restore-db check passed', { tables: result.tables, kept: values.keep === true });
        else logLine('error', 'restore-db failed', { detail: result.detail });
        return result.ok ? 0 : 1;
      }
      case 'restore-media': {
        if (!values.identity) break;
        const result = await restoreMedia(env, {
          identity: values.identity as string,
          prefix: values.prefix as string | undefined,
        });
        logLine(result.ok ? 'log' : 'error', result.ok ? 'restore-media done' : 'restore-media failed', {
          restored: result.restored,
          skipped: result.skipped,
          failed: result.failed,
          detail: result.detail,
        });
        return result.ok ? 0 : 1;
      }
      default:
        process.stderr.write(`Unknown command: ${failureDetail(command)}\n${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    logLine('error', `${command} failed`, { detail: failureDetail(error) });
    return 1;
  }
  process.stderr.write(`Missing options for ${command}\n${USAGE}\n`);
  return 2;
}

// Only when run as the entry point (the e2e imports the functions instead).
if (process.argv[1] && /[\\/]backup[\\/]main\.[jt]s$/.test(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
