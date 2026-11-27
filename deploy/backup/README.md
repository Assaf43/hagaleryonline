# Backups

The `backup` service (target `backup` of the root `Dockerfile`: the app files plus
`postgresql-client-18` and `age`) runs `node apps/api/dist/backup/main.js daemon`.
Sources: `apps/api/src/backup/`. Spec 9b.5, NFR-09.

Every run writes a `backup_runs` row (kind `db`, `media` or `restore_test`). The
admin screen "תקלות ומצב המערכת" shows the last ones, and a row with `ok = false`
sends an alert (with `BACKUP_EXPECTED=true`, so does no successful `db` run for 26 h).
`detail` holds one scrubbed line, never a key or a URL with credentials. The tool logs
one scrubbed JSON line per event and never prints a key or decrypted content.

## Commands

| Command                                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon`                                                                                         | Every day at `BACKUP_AT` (Israel time, default `02:30`, correct across summer time) runs `db`, then `media`. Stops cleanly on SIGTERM (a run in progress is stopped and recorded as failed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `db`                                                                                             | One `REPEATABLE READ READ ONLY` transaction exports a snapshot; the row count of every table in `public` is read in it, and `pg_dump --format=custom --snapshot=<id> --no-owner --no-acl` dumps the same state. The dump goes through `age --encrypt --recipient $BACKUP_AGE_RECIPIENT` to `db/<YYYY-MM-DD>/nesto-<ISO>.dump.age`; the counts go, encrypted the same way, to `….counts.json.age`. A failed dump never completes an object (the upload is aborted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `media`                                                                                          | Lists both media buckets and copies each object whose `LastModified` is after the last successful media run's start minus 1 hour (every object on the first run), each encrypted on its own to `media/<public\|private>/<key>.age`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `restore-db --object <key> --identity <file> --target-db <name> [--keep] [--owner <role>\|none]` | Downloads and decrypts the dump and its counts file into a temp dir (mode 0700, always removed), creates `<name>` (refused when a database of that name exists at all, empty or not, so every run creates its own target; `postgres`, the templates and the admin / record databases are refused too), creates it `OWNER <role>` (default `DB_OWNER_ROLE`, else `nesto_owner`; the restore admin must be able to `SET ROLE` to it, a missing or superuser role is refused before anything starts), gives it schema `public`, nothing for `PUBLIC` (as `deploy/postgres/init/01-roles.sh`), runs `pg_restore --no-owner --no-acl --role=<role> --exit-on-error` so every restored object is that role's, fails when any table, sequence, function or type in `public` is owned by someone else (extension members aside), then compares the row count of every table with the counts file: an exact match per table, otherwise every mismatch is printed and it exits 1. Drops `<name>` afterwards unless `--keep`. Writes a `restore_test` row when `RESTORE_RECORD_DATABASE_URL` is set. |
| `restore-media --identity <file> [--prefix <p>]`                                                 | Decrypts each backup object under `<p>` (default `media/`) and puts it back into the media bucket its prefix names, with the API's content type and cache headers. Objects that exist are skipped, so it can run again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Exit codes: 0 ok, 1 a run or a check failed, 2 a usage error.

**Production check.** With `NODE_ENV=production` (as in the `backup` service) every command first runs the tool's own
check (`assertBackupProductionEnv` in `backup-common.ts`) and refuses to start when it fails: `BACKUP_S3_ENDPOINT` and
`S3_ENDPOINT` must be https URLs (http only with `APP_ENV=staging` and a host without a dot or ending in `.localhost`,
the rehearsal's MinIO), `BACKUP_AGE_RECIPIENT` must be an age public key (`age1…`), and a remote
`BACKUP_DATABASE_URL` (a host with a dot) needs `sslmode=require`, `verify-ca` or `verify-full`. The error is one line
that names each variable and the rule, never a value.

## Keys per command

The nightly commands get their settings from the `backup` service in
`docker-compose.prod.yml` (names in `deploy/env.prod.example`, values only in the
server's env file):

| Command                 | Variables                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daemon`, `db`, `media` | `BACKUP_DATABASE_URL` (role `nesto_backup`), `BACKUP_AGE_RECIPIENT`, `BACKUP_AT`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` (backup-writer: PutObject + AbortMultipartUpload on the backup bucket, read + list on the media buckets); for `media` also `S3_ENDPOINT`, `S3_REGION`, `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET`, `S3_FORCE_PATH_STYLE` |

The writer key cannot read, list or delete in the (versioned) backup bucket, so the
media run never looks there: "new" comes from `backup_runs`.

The restore commands are **one-off**: their keys are given at run time only and are
**never** put in the server env file or in `docker-compose.prod.yml`:

| Command         | Extra variables (besides `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `S3_FORCE_PATH_STYLE`)                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restore-db`    | `RESTORE_ADMIN_DATABASE_URL` (a role that may CREATE / DROP databases: the `postgres` superuser), `BACKUP_READ_ACCESS_KEY_ID` / `BACKUP_READ_SECRET_ACCESS_KEY` (backup-reader), optional `RESTORE_RECORD_DATABASE_URL` (the app database as `nesto_backup`, for the `restore_test` row) |
| `restore-media` | `BACKUP_READ_ACCESS_KEY_ID` / `BACKUP_READ_SECRET_ACCESS_KEY`, `RESTORE_S3_ACCESS_KEY_ID` / `RESTORE_S3_SECRET_ACCESS_KEY` (the app user's media keys), `S3_ENDPOINT`, `S3_REGION`, `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET`                                                              |

The age **private key** (the identity file) stays offline with the owner. Bring it to
the server only for a restore, readable by the container's `node` user (uid 1000),
and delete it afterwards.

## Running a restore

Read each secret into the shell without echoing it, and pass it to the container by
name only (`-e NAME`, no value), so it is never on a command line or in the shell
history:

```sh
read -rs RESTORE_ADMIN_DATABASE_URL; export RESTORE_ADMIN_DATABASE_URL
read -rs BACKUP_READ_ACCESS_KEY_ID; export BACKUP_READ_ACCESS_KEY_ID
read -rs BACKUP_READ_SECRET_ACCESS_KEY; export BACKUP_READ_SECRET_ACCESS_KEY
read -rs RESTORE_RECORD_DATABASE_URL; export RESTORE_RECORD_DATABASE_URL   # optional

IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml --env-file <env file> run --rm --no-deps \
  -e RESTORE_ADMIN_DATABASE_URL -e BACKUP_READ_ACCESS_KEY_ID -e BACKUP_READ_SECRET_ACCESS_KEY \
  -e RESTORE_RECORD_DATABASE_URL \
  -v /root/restore/identity.txt:/run/identity.txt:ro \
  backup node apps/api/dist/backup/main.js restore-db \
  --object db/2026-11-26/nesto-2026-11-26T00:30:00.123Z.dump.age \
  --identity /run/identity.txt --target-db nesto_restore_check
```

The object key is in the bucket listing (backup-reader keys). The monthly restore test
is exactly this command without `--keep` (it restores as `nesto_owner` too, so the
ownership check runs every month; `--owner none` restores as the admin, for a cluster
without that role). A real restore uses `--keep` and a new name:

```sh
IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml --env-file <env file> run --rm --no-deps \
  -e RESTORE_ADMIN_DATABASE_URL -e BACKUP_READ_ACCESS_KEY_ID -e BACKUP_READ_SECRET_ACCESS_KEY \
  -v /root/restore/identity.txt:/run/identity.txt:ro \
  backup node apps/api/dist/backup/main.js restore-db \
  --object db/2026-11-26/nesto-2026-11-26T00:30:00.123Z.dump.age \
  --identity /run/identity.txt --target-db nesto_restored --keep
```

Then, with `api` and `web` stopped:

1. Run the migrate service against it: set `MIGRATE_DATABASE_URL` in the env file to
   `postgresql://nesto_owner:<owner password>@postgres:5432/nesto_restored`, then

   ```sh
   IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml --env-file <env file> \
     --profile deploy run --rm migrate
   ```

   `prisma migrate deploy` applies any newer migration and `apply-db-grants` grants
   `nesto_app` and `nesto_backup` (it refuses unless `nesto_owner` owns the tables,
   which `--owner` ensures).

2. Point `DATABASE_URL` (and `BACKUP_DATABASE_URL`) at `nesto_restored` and redeploy
   (`deploy/deploy.sh <tag>`), then check `/api/health` and an order lookup.

`restore-media` runs the same way with `-e BACKUP_READ_ACCESS_KEY_ID
-e BACKUP_READ_SECRET_ACCESS_KEY -e RESTORE_S3_ACCESS_KEY_ID -e RESTORE_S3_SECRET_ACCESS_KEY`
and `restore-media --identity /run/identity.txt [--prefix media/public/]`.

## Retention

- `db/`: current objects expire after 30 days (bucket lifecycle); noncurrent versions
  30 days after they were replaced.
- `media/`: never expires. Photo files are immutable with unique keys, so only new ones
  are copied, and a 30-day expiry would lose every photo older than that. Removing old
  support photos from the backup follows the 9e retention rule (a lifecycle rule on
  `media/private/support/`).
- A photo deleted from the site stays in the backup.
