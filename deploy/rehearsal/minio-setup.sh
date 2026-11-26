#!/bin/sh
# Rehearsal only (deploy/rehearsal/docker-compose.rehearsal.yml, service minio-setup): prepares the local MinIO test
# double. Idempotent: every `up` may run it again and it ends in the same state.
#   - buckets $S3_PUBLIC_BUCKET (anonymous GetObject, no listing), $S3_PRIVATE_BUCKET (no anonymous access) and
#     $BACKUP_S3_BUCKET (versioned; lifecycle: current objects under db/ expire after 30 days, media/ never; any
#     noncurrent version, anywhere in the bucket, 30 days after it was replaced);
#   - user app            read / write on both media buckets (the API);
#   - user backup-writer  PutObject + AbortMultipartUpload on the backup bucket only: it cannot read, list or
#                         delete; an overwrite only adds a newer version, and the old one is kept 30 days (no
#                         DeleteObjectVersion, PutBucketVersioning or PutLifecycleConfiguration). Plus read on both
#                         media buckets for the photo copy;
#   - user backup-reader  read on the backup bucket (restore time only).
# Secrets come from the environment only. They reach mc through MC_HOST_local and stdin (printf is a shell builtin),
# never as command-line arguments, and nothing here prints them. No `set -x`.
set -eu

for name in MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_PUBLIC_BUCKET S3_PRIVATE_BUCKET BACKUP_S3_BUCKET \
  APP_ACCESS_KEY APP_SECRET_KEY BACKUP_WRITER_ACCESS_KEY BACKUP_WRITER_SECRET_KEY \
  BACKUP_READER_ACCESS_KEY BACKUP_READER_SECRET_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "minio-setup: $name is empty or not set" >&2
    exit 1
  fi
done
unset value

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/mc"

# The generated keys are URL-safe (base64url), so they need no escaping inside the URL.
MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000"
export MC_HOST_local
mcx() {
  mc --quiet --no-color --config-dir "$work/mc" "$@"
}

pub="$S3_PUBLIC_BUCKET"
priv="$S3_PRIVATE_BUCKET"
backups="$BACKUP_S3_BUCKET"

for bucket in "$pub" "$priv" "$backups"; do
  mcx mb --ignore-existing "local/$bucket" >/dev/null
done
# Anonymous GetObject only. MinIO's canned `download` policy also allows ListBucket, which would let anyone list
# every photo key (hidden products included); set-json replaces the bucket policy, so a rerun ends the same.
cat >"$work/public-read.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": ["*"] },
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$pub/*"]
    }
  ]
}
EOF
mcx anonymous set-json "$work/public-read.json" "local/$pub" >/dev/null
mcx anonymous set none "local/$priv" >/dev/null
mcx anonymous set none "local/$backups" >/dev/null

# Versioning: the dump keys are predictable, so without it the writer's key could destroy a backup by writing over
# its key. Now an overwrite only adds a newer version.
mcx version enable "local/$backups" >/dev/null

# Import replaces the whole lifecycle configuration, so a second run never adds a duplicate rule.
cat >"$work/lifecycle.json" <<'EOF'
{
  "Rules": [
    { "ID": "expire-db-dumps", "Status": "Enabled", "Filter": { "Prefix": "db/" }, "Expiration": { "Days": 30 } },
    {
      "ID": "expire-noncurrent-versions",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    }
  ]
}
EOF
mcx ilm import "local/$backups" <"$work/lifecycle.json" >/dev/null

cat >"$work/app.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$pub", "arn:aws:s3:::$priv"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$pub/*", "arn:aws:s3:::$priv/*"]
    }
  ]
}
EOF

cat >"$work/backup-writer.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::$backups/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$pub", "arn:aws:s3:::$priv"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$pub/*", "arn:aws:s3:::$priv/*"]
    }
  ]
}
EOF

cat >"$work/backup-reader.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$backups"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$backups/*"]
    }
  ]
}
EOF

# user_with_policy <access key> <secret> <policy name> <policy file>
# `policy create` and `user add` replace an existing policy / secret; `attach` of a policy already attached is not an
# error here.
user_with_policy() {
  mcx admin policy create local "$3" "$4" >/dev/null
  printf '%s\n' "$2" | mcx admin user add local "$1" >/dev/null
  if ! mcx admin policy attach local "$3" --user "$1" >/dev/null 2>"$work/attach.err"; then
    if ! grep -qi 'already' "$work/attach.err"; then
      cat "$work/attach.err" >&2
      exit 1
    fi
  fi
}

user_with_policy "$APP_ACCESS_KEY" "$APP_SECRET_KEY" nesto-app "$work/app.json"
user_with_policy "$BACKUP_WRITER_ACCESS_KEY" "$BACKUP_WRITER_SECRET_KEY" nesto-backup-writer "$work/backup-writer.json"
user_with_policy "$BACKUP_READER_ACCESS_KEY" "$BACKUP_READER_SECRET_KEY" nesto-backup-reader "$work/backup-reader.json"

echo "minio-setup: buckets $pub, $priv, $backups and users app, backup-writer, backup-reader are ready"
