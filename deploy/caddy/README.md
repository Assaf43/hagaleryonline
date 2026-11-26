# Caddy

The production Caddyfile and the snippets it imports. The `caddy` target of the
root `Dockerfile` copies `Caddyfile` and `*.caddy` to `/etc/caddy/` and the admin
build to `/srv/admin`.

## Caddyfile

- Global options: `order rate_limit before basic_auth` (`basicauth` is the deprecated
  name in Caddy 2.11), then `{$CADDY_GLOBAL_OPTIONS}`. No `trusted_proxies` in 9b:
  nothing sits in front of Caddy, so a client's `X-Forwarded-For` is ignored. 9c adds
  Cloudflare's ranges. `log default` (stderr: errors, TLS, startup, debug) uses the same
  filter as the access log (`uri` and `request>uri` without the query, no `Referer`,
  `Cookie`, `Authorization`), so `?t=` / `?preview=` never reach any log, even with
  `debug`. 9c must not add its own `log default` in `CADDY_GLOBAL_OPTIONS`.
- `(common)`, on both hosts: `encode zstd gzip`; HSTS `max-age=31536000` (no
  `includeSubDomains` / `preload` until 9c); no `Server` header (also on Caddy's own
  error answers, through `handle_errors`); an access log on stdout whose `request>uri`
  has the query string cut off (tokens, preview links) and without the `Referer`,
  `Cookie`, `Authorization` request headers or the `Set-Cookie` response header.
  `handle_errors` must stay: Caddy's own error answers skip the deferred headers, and
  since it handles the error, Caddy logs the error itself only at debug level, so
  `log_append error_message {err.message}` puts it on the access line (e.g. status 502
  with `dial tcp: lookup web: ...`, any `?query` cut off).
- `(blocked)`, on both hosts: `/api/internal`, `/api/internal/*`, `/api/admin/dev`,
  `/api/admin/dev/*` answer 404 (Caddy's path matcher is case-insensitive and cleans
  `//` and `%xx` first).
- `(media)`, on both hosts: `/media/<key>` -> `{$S3_PUBLIC_UPSTREAM}/{$S3_PUBLIC_BUCKET}/<key>`
  (path-style; matches `S3Storage.publicUrl`). Only `GET` / `HEAD` (others 405 with
  `Allow`); the original request URI must be a plain key (`[A-Za-z0-9._/-]`, no `%`
  escapes, `\`, `..` or `//`, else 404); the query string, `Authorization` and `Cookie`
  are dropped and `Host` is the upstream's, so a client cannot use Caddy as an S3 proxy
  with its own credentials or reach another bucket. Found photos get
  `Cache-Control: public, max-age=31536000, immutable`; every answer gets `nosniff`;
  `X-Amz-*`, `X-Ratelimit-*` and `X-Xss-Protection` from S3 are removed. A path trick such
  as `/media/../<bucket>/...` never matches `/media/*` (the matcher cleans the path) and
  goes to the storefront or the admin files, never to S3.
- `{$SITE_HOST}`: `common`, `blocked`, `webhook_limits`, `media`; `/api/*` -> `api:3000`,
  the rest -> `web:4000` (the storefront sets its own headers and CSP).
- `{$ADMIN_HOST}`: `common`, `blocked`, `admin_headers`, `media`; the two webhooks answer
  404 (they live only on the site host); `/api/*` -> `api:3000`; the rest from
  `/srv/admin` with `try_files {path} /index.html`. Content-hashed files
  (`<name>-<8 chars>.js|css`, `static-media/*`) are `immutable` for a year and a
  missing one is a 404; `index.html` and every other file are `no-cache`.

Env read: `SITE_HOST`, `ADMIN_HOST`, `S3_PUBLIC_BUCKET`, `S3_PUBLIC_UPSTREAM`
(e.g. `http://minio:9000` in the rehearsal), `CADDY_GLOBAL_OPTIONS` (`local_certs` in
the rehearsal; empty is allowed). `scripts/caddyfile.spec.mjs` checks the text.

### Validate

```sh
docker build --target caddy -t nesto-caddy:check .
# JSON, no warnings:
docker run --rm -e SITE_HOST=nesto.localhost -e ADMIN_HOST=admin.nesto.localhost \
  -e S3_PUBLIC_BUCKET=nesto-media-public -e S3_PUBLIC_UPSTREAM=http://minio:9000 \
  -e CADDY_GLOBAL_OPTIONS=local_certs nesto-caddy:check caddy adapt --config /etc/caddy/Caddyfile
docker run --rm nesto-caddy:check caddy fmt --diff /etc/caddy/Caddyfile   # no line starting with + or -
```

Live: on a private docker network with MinIO as `minio` (no host ports), run the image
and curl it from a second container with `--resolve nesto.localhost:443:<caddy ip>`
and `--path-as-is`: a public object answers 200 with `immutable` and `nosniff` and no
`x-amz-*`; the private bucket through `/media/..%2f<bucket>/...`, `/media/%2e%2e/...`,
`/media/../...`, `/media/<bucket>/...` or `/<bucket>/...` never returns the object;
`POST /media/x` is 405; `/api/internal/x` and `/api/admin/dev/x` are 404 on both hosts.

## Snippets

- `admin-headers.caddy` defines `(admin_headers)`: the Content-Security-Policy
  (no framing, no `unsafe-eval`, `unsafe-inline` for styles only because Angular
  Material injects `<style>` tags at run time), `nosniff`, `X-Frame-Options`,
  `Referrer-Policy`, a `Permissions-Policy` that allows only the camera (product
  photos from the phone), `X-Robots-Tag` and `-Server`. It has no HSTS; the 9b site
  block adds it.
- `api-limits.caddy` defines `(webhook_limits)`: a 64KB body limit and a rate limit
  (120 events per minute per `{remote_host}`) on `/api/payments/webhook` and
  `/api/marketing/webhook`.

## Use in 9b

The 9a example below uses the old directive name `basicauth`; the Caddyfile uses
`basic_auth`, the current name in Caddy 2.11 (both are accepted).

```caddyfile
{
	order rate_limit before basicauth
}

admin.example.test {
	import admin_headers
	# ...
}

shop.example.test {
	import webhook_limits
	# ...
}
```

`rate_limit` is not part of stock Caddy. Build a custom image with
`xcaddy build --with github.com/mholt/caddy-ratelimit`, and keep
`order rate_limit before basicauth` in the global options (a plugin directive has
no default position). Behind a proxy, make sure `{remote_host}` is the real client
address (set `trusted_proxies`), or every caller shares one bucket.

## 9b check

Done in the 9b-2 local rehearsal (production images, `local_certs`, MinIO as the S3 test double):
`caddy adapt` gives JSON with no warnings and `caddy fmt --diff` is clean; the admin host answers
with every header from the snippet, HSTS and no `Server` header; `?t=` / `?preview=` sentinels,
`Cookie` and `Referer` never reach the Caddy log; 130 webhook POSTs in a minute gave 120 x 401
then 429, a 70 KB body gave 413, the webhooks answer 404 on the admin host; `/api/internal/*` and
`/api/admin/dev/*` are 404 on both hosts; `/media/..%2f<private bucket>/...`, `/media/%2e%2e/...`,
`/media/<bucket>/...` and the like never return the private object; a deep admin URL (an invite
link) loads every asset. To repeat it:

```sh
# admin: every header from the snippet is present, no Server header
curl -sI https://admin.example.test/

# webhook flood: after 120 requests in a minute the answer becomes 429
for i in $(seq 1 130); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://shop.example.test/api/payments/webhook -d '{}'
done | sort | uniq -c

# body limit: a body over 64KB answers 413
head -c 70000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- https://shop.example.test/api/payments/webhook

# CSP: verify against the real built admin index.html (apps/admin/dist/admin/browser):
# no inline <script> and no on*= attributes, or script-src 'self' blocks them.
# The admin production build sets inlineCritical to false for this reason.
grep -cE '<script[^>]*>[^<]' index.html; grep -cE ' on[a-z]+=' index.html   # both 0

# base-uri is 'self' (not 'none') so the index.html <base href="/"> still works: open a deep admin URL
# (e.g. an invite link) in a real browser, not only curl -sI /. Every asset must load, the page must not be blank.
```

Validate syntax with `caddy fmt --diff` and `caddy adapt` before deploying.
