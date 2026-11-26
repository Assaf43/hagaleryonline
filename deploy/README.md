# Operating NESTO in production (operator entry point)

Run everything from the repository root on the server. Details: [caddy/README.md](caddy/README.md) (proxy, headers,
validation) and [backup/README.md](backup/README.md) (backups, restore). Secrets live only in the env file
(`deploy/env.prod.example` is the template); never put them on a command line or in git.

## Build, deploy, roll back

```sh
deploy/build.sh <tag>      # builds nesto-app, nesto-caddy, nesto-backup at <tag>
deploy/deploy.sh <tag>     # infra -> setup services -> migrate gate -> health gate; keeps the previous tag for rollback
deploy/rollback.sh         # redeploys the previous tag without migrating (the schema is expand-only)
```

Environment of `deploy.sh` / `rollback.sh` (all optional):

- `DEPLOY_COMPOSE_ARGS` - compose arguments, default `-f docker-compose.prod.yml` (add `--env-file <file>` here).
- `DEPLOY_INFRA_SERVICES` - services started first, default `postgres`.
- `DEPLOY_SETUP_SERVICES` - one-shot services run once before the migration, default none.
- `DEPLOY_STATE_DIR` - current / previous tag and the lock, default `deploy/state`.

Stale lock: if a deploy was killed, `deploy/state/.lock` stays behind. When no deploy is running, `rmdir` it.

Failed migration (Prisma P3009): Prisma does not wrap a migration in a transaction. First undo whatever the failed
migration already applied, then mark it with `npx prisma migrate resolve --rolled-back <name>` (the deploy output
prints the full command). Until then every later migrate refuses to run; the old version keeps serving.

## CLI inside the image

`npm run admin` does not exist in the pruned image. Run the compiled CLI in a one-off container:

```sh
IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml --env-file <file> run --rm --no-deps api \
  node apps/api/dist/cli.js <command> [options]
```

Commands: `create-super-admin --email <e-mail> --name "<name>"` (prints an invite link), `apply-db-grants`,
`copy-media-to-s3 [--dry-run]`, `seal-order-tokens`. Pass the e-mail only at runtime.

## Backups

Restart the backup service after changing its env or keys: `IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml
--env-file <file> up -d --no-deps backup`.
