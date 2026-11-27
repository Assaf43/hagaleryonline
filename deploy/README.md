# Operating NESTO in production (operator entry point)

Run everything from the repository root on the server. Details: [caddy/README.md](caddy/README.md) (proxy, headers,
validation) and [backup/README.md](backup/README.md) (backups, restore). Secrets live only in the env file
(`deploy/env.prod.example` is the template); never put them on a command line or in git.

## Build, deploy, roll back

```sh
deploy/build.sh <tag>      # builds nesto-app, nesto-caddy, nesto-backup at <tag>
deploy/deploy.sh <tag>     # env check -> infra -> setup services -> migrate gate -> health gate; keeps the previous tag
deploy/rollback.sh         # redeploys the previous tag without migrating (the schema is expand-only)
```

Environment of `deploy.sh` / `rollback.sh` (optional, except that `deploy.sh` needs an env file from one of the first
two):

- `DEPLOY_COMPOSE_ARGS` - compose arguments, default `-f docker-compose.prod.yml` (add `--env-file <file>` here).
- `DEPLOY_ENV_FILE` - the env file `deploy.sh` checks first, default the `--env-file` of `DEPLOY_COMPOSE_ARGS`.
- `DEPLOY_INFRA_SERVICES` - services started first, default `postgres`.
- `DEPLOY_SETUP_SERVICES` - one-shot services run once before the migration, default none.
- `DEPLOY_STATE_DIR` - current / previous tag and the lock, default `deploy/state`.

Env check (before anything changes): `deploy.sh` runs `deploy/check-env.mjs` in the new `nesto-app` image (no network,
no capabilities, read-only root, the caller's uid; the env file, `docker-compose.prod.yml` and
`deploy/cloudflare-ips.txt` mounted read-only). It lists every problem at once and refuses when:

- `SITE_HOST`, `SITE_URL`, `STOREFRONT_URL` and `NG_ALLOWED_HOSTS` disagree, or `ADMIN_HOST` and `ADMIN_URL` do (any
  of them missing counts too);
- `TRUST_PROXY` is not the compose file's edge subnet (`networks.edge`);
- `CADDY_ENV` is missing or not production / staging / rehearsal, or does not match `APP_ENV` (production on both or
  on neither; an empty `APP_ENV` is production), or `SEO_INDEXING` is not `true` exactly when `APP_ENV` is production;
- `CADDY_TLS` is set to anything but `origin` or `auto`;
- on staging and production: `CF_TRUSTED_RANGES` is not exactly the set of `deploy/cloudflare-ips.txt` (an extra or a
  missing range is refused; order and spacing are free), `CADDY_TLS` is not `origin`, or `CADDY_ORIGIN_DIR` is empty or
  the repo's `no-origin` folder;
- on the rehearsal: `SITE_HOST` or `ADMIN_HOST` is not `localhost` / `*.localhost`, or `CADDY_TLS` is not `auto` (or
  empty);
- on staging: `STAGING_AUTH_USER` or `STAGING_AUTH_HASH` is empty;
- `STAGING_AUTH_HASH` would not reach Caddy intact (a `$` outside single quotes that is not written `$$`: Compose
  would expand it), or is not a bcrypt hash (`$2a$` / `$2b$` / `$2y$`, cost, 53 characters).

It names keys and rules, never values. From the host: `node deploy/check-env.mjs <env-file>`. The container runs with
`--cap-drop ALL`, so even root cannot read a 0600 env file owned by another user: the env file must be owned by the
user who runs `deploy.sh` (root on the server).

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
