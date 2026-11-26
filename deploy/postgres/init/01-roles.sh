#!/usr/bin/env bash
# First volume init of the official postgres:18 image (/docker-entrypoint-initdb.d), run as POSTGRES_USER (the
# cluster superuser `postgres`, used only here and by a restore). Phase 9b, HANDOFF 9b: the app must not own its
# tables, so three roles are created:
#   nesto_owner  - owns database `nesto` and schema `public`; used only by the migrate service
#                  (`prisma migrate deploy && node apps/api/dist/cli.js apply-db-grants`);
#   nesto_app    - the API (DATABASE_URL); privileges come from apply-db-grants after every migrate;
#   nesto_backup - the backup job (read-only except its own backup_runs rows).
# Passwords: NESTO_OWNER_PASSWORD, NESTO_APP_PASSWORD, NESTO_BACKUP_PASSWORD (never echoed; read inside psql with
# \getenv and quoted by psql itself with :'name', never pasted into the SQL text or onto a command line).
set -euo pipefail

for name in NESTO_OWNER_PASSWORD NESTO_APP_PASSWORD NESTO_BACKUP_PASSWORD; do
  if [ -z "${!name:-}" ]; then
    echo "01-roles.sh: ${name} is empty or not set" >&2
    exit 1
  fi
done

# psql reads the passwords from its own environment (\getenv), so they never appear on a command line (/proc cmdline).
psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv owner_pw NESTO_OWNER_PASSWORD
\getenv app_pw NESTO_APP_PASSWORD
\getenv backup_pw NESTO_BACKUP_PASSWORD
CREATE ROLE nesto_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'owner_pw';
CREATE ROLE nesto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'app_pw';
CREATE ROLE nesto_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'backup_pw';
CREATE DATABASE nesto OWNER nesto_owner;
REVOKE ALL ON DATABASE nesto FROM PUBLIC;
GRANT CONNECT ON DATABASE nesto TO nesto_app;
GRANT CONNECT ON DATABASE nesto TO nesto_backup;
SQL

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname nesto <<'SQL'
ALTER SCHEMA public OWNER TO nesto_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nesto_app;
GRANT USAGE ON SCHEMA public TO nesto_backup;
SQL

echo "01-roles.sh: roles nesto_owner, nesto_app, nesto_backup and database nesto created"
