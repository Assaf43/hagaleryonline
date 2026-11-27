# Caddy

The production Caddyfile and the files it imports. The `caddy` target of the root
`Dockerfile` copies `Caddyfile`, the two snippet files, `env-*.caddy` and `tls-*.caddy`
to `/etc/caddy/` and the admin build to `/srv/admin`. The Cloudflare Origin CA
certificate is never in the image: compose mounts it at `/etc/caddy/origin`.

## Caddyfile

- Global options: `order rate_limit before basic_auth` (`basicauth` is the deprecated
  name in Caddy 2.11), the Cloudflare client-IP settings (see "Behind Cloudflare"), then
  `{$CADDY_GLOBAL_OPTIONS}`. `log default` (stderr: errors, TLS, startup, debug) uses the same
  filter as the access log (`uri` and `request>uri` without the query, no `Referer`,
  `Cookie`, `Authorization`), so `?t=` / `?preview=` never reach any log, even with
  `debug`. 9c must not add its own `log default` in `CADDY_GLOBAL_OPTIONS`.
- `(common)`, on both hosts: `encode zstd gzip`; HSTS `max-age=31536000; includeSubDomains`
  (no `preload`); no `Server` header (also on Caddy's own
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
  escapes, `\`, `..` or `//`, else 404); the query string, `Authorization`, `Cookie`, `X-Forwarded-For` and `CF-Connecting-IP`
  are dropped and `Host` is the upstream's, so a client cannot use Caddy as an S3 proxy
  with its own credentials or reach another bucket. Found photos get
  `Cache-Control: public, max-age=31536000, immutable`; every answer gets `nosniff`;
  `X-Amz-*`, `X-Ratelimit-*` and `X-Xss-Protection` from S3 are removed. A path trick such
  as `/media/../<bucket>/...` never matches `/media/*` (the matcher cleans the path) and
  goes to the storefront or the admin files, never to S3.
- `{$SITE_HOST}`: `env-{$CADDY_ENV}.caddy`, `tls-{$CADDY_TLS}.caddy`, `common`, `blocked`,
  `webhook_limits`, `media`; `/api/*` -> `api:3000`, the rest -> `web:4000` (the storefront
  sets its own headers and CSP). Body limits: `/api/support/damaged` 55MB (5 photos of
  10 MiB in one form plus multipart overhead; Caddy's `MB` is 1000 x 1000 bytes), every other path 1MB (`@not_damaged`), the webhooks 64KB.
- `{$ADMIN_HOST}`: `env-{$CADDY_ENV}.caddy`, `tls-{$CADDY_TLS}.caddy`, `common`, `blocked`,
  `admin_headers`, `media`; body limit 16MB (product and content photos up to 15 MB,
  Excel 5 MB); the two webhooks answer 404 (they live only on the site host); `/api/*` -> `api:3000`; the rest from
  `/srv/admin` with `try_files {path} /index.html`. Content-hashed files
  (`<name>-<8 chars>.js|css`, `static-media/*`) are `immutable` for a year and a
  missing one is a 404; `index.html` and every other file are `no-cache`.

Body limits never nest: two `request_body` limits on one request do not replace each
other, the smaller one wins (checked with real Caddy: with a catch-all 1MB next to the
large matcher, a 40 MB damaged report got 413). So the general limit uses the negated
matcher `@not_damaged`, and the webhooks' 64KB works because it is the smaller one.
Both matchers test the raw request URI (`{http.request.orig_uri}`), not the cleaned path,
so an encoded path such as `/x/..%2fapi/support/damaged` (forwarded raw) keeps 1MB.

Env read: `SITE_HOST`, `ADMIN_HOST`, `S3_PUBLIC_BUCKET`, `S3_PUBLIC_UPSTREAM`
(e.g. `http://minio:9000` in the rehearsal), `CADDY_GLOBAL_OPTIONS` (`local_certs` in
the rehearsal; empty is allowed), `CF_TRUSTED_RANGES`, `CADDY_ENV`, `CADDY_TLS`,
`STAGING_AUTH_USER`, `STAGING_AUTH_HASH`. `scripts/caddyfile.spec.mjs` and
`scripts/caddy-snippets.spec.mjs` check the text; `scripts/caddy-proxy.spec.mjs` runs it.

## Behind Cloudflare (decision 106)

- **Client IP.** The global `servers` block has `trusted_proxies static {$CF_TRUSTED_RANGES}`,
  `client_ip_headers CF-Connecting-IP` and `trusted_proxies_strict`. Only a connection from
  a listed range may name the client in `CF-Connecting-IP`; from anywhere else the header
  (and any `X-Forwarded-For`) is ignored and the peer address is the client. `{client_ip}`
  is the result: every `reverse_proxy api:3000` / `web:4000` sends it as the only
  `X-Forwarded-For` value (a client's own value is replaced, never appended) and drops
  `CF-Connecting-IP`, and the webhook rate limit uses `key {client_ip}`. The API trusts
  only Caddy's network (`TRUST_PROXY`), so it reads exactly that one address.
- **`CF_TRUSTED_RANGES`** is the list in `deploy/cloudflare-ips.txt`, space-joined (the env
  tooling writes it; an empty value trusts nothing). The rehearsal sets `127.0.0.1/32`, so
  nothing on the Docker network is trusted by accident.
- **Refresh `cloudflare-ips.txt`** when Cloudflare announces a change (and before each
  launch step): fetch both lists, keep one CIDR per line, update the date in the header,
  and review the diff before committing. A range must never be typed from memory:

  ```sh
  { echo "# Cloudflare edge ranges, fetched $(date -u +%F) from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6."
    sed -n '2,3p' deploy/cloudflare-ips.txt
    curl -fsS https://www.cloudflare.com/ips-v4; echo
    curl -fsS https://www.cloudflare.com/ips-v6; echo
  } | tr -d '\r' | sed '/^$/d' > deploy/cloudflare-ips.new && mv deploy/cloudflare-ips.new deploy/cloudflare-ips.txt
  git diff deploy/cloudflare-ips.txt
  ```

  Then regenerate the env (`CF_TRUSTED_RANGES`) and the firewall rules, and redeploy Caddy.

- **Environment switch** `import env-{$CADDY_ENV}.caddy` in both site blocks:
  - `env-production.caddy`: nothing.
  - `env-staging.caddy`: `X-Robots-Tag: noindex, nofollow` and a login gate
    (`basic_auth` with `STAGING_AUTH_USER` and the bcrypt `STAGING_AUTH_HASH` from
    `caddy hash-password` in the caddy image). **Gate exemptions:** `/api/health` (uptime
    checks) and `/robots.txt` (crawlers must still read `Disallow: /`), matched on the raw
    request URI with an optional query, so an encoded path that only cleans to an exempt one
    (`/x/%2e%2e%2frobots.txt`) stays gated; on the admin host
    `/robots.txt` falls through to the SPA's `try_files`, which is harmless. After the gate,
    `request_header -Authorization` keeps the gate password away from the upstreams. The two
    values are quoted, so an empty user or hash makes Caddy refuse to start: a misconfigured
    staging fails closed. Note that the payment and marketing webhooks are gated too, so a
    provider's sandbox cannot call staging until they are exempted.
  - `env-rehearsal.caddy`: the same `X-Robots-Tag`, no gate.
  - An empty or unset `CADDY_ENV` names `env-.caddy`, which does not exist, and Caddy refuses
    to start. Never set it to a glob character such as `*`.
- **TLS switch** `import tls-{$CADDY_TLS}.caddy`: `origin` loads the Cloudflare Origin CA
  certificate from `/etc/caddy/origin/cert.pem` and `key.pem`; `auto` adds nothing (Caddy's
  own certificates, or `local_certs` from `CADDY_GLOBAL_OPTIONS` in the rehearsal). Empty
  fails like `CADDY_ENV`.

### Proxy spec

`npx vitest run scripts/caddy-proxy.spec.mjs` starts real Caddy on a throwaway Docker
network (every container and network named `nesto9c1-cp-<pid>-…`, removed afterwards; no
host port published) with `scripts/fixtures/echo-upstream.mjs` as `api` and `web`, and two
client containers: one listed in `CF_TRUSTED_RANGES` (a Cloudflare edge) and one not. It
covers the client IP (untrusted, trusted, overwritten `X-Forwarded-For`, one rate-limit
bucket per real client), the staging gate and its exemptions, production without gate or
`X-Robots-Tag`, HSTS, the body limits and the refusal to start without `CADDY_ENV`,
`CADDY_TLS` or the staging credentials. It is opt-in: it runs only with Docker and `CADDY_TEST_IMAGE` set or
`CADDY_PROXY_SPEC=1`, so a plain `npm test` skips it. CI passes
`CADDY_TEST_IMAGE=nesto-caddy:ci`; with `CADDY_PROXY_SPEC=1` alone the spec builds
only the Dockerfile's `caddy-builder` stage into
`nesto9c1-caddy-test:local` and mounts `deploy/caddy/` (images removed afterwards unless
`CADDY_TEST_KEEP_IMAGES=1`).

### Validate

```sh
docker build --target caddy -t nesto-caddy:check .
# JSON, no warnings:
docker run --rm -e SITE_HOST=nesto.localhost -e ADMIN_HOST=admin.nesto.localhost \
  -e S3_PUBLIC_BUCKET=nesto-media-public -e S3_PUBLIC_UPSTREAM=http://minio:9000 \
  -e CADDY_GLOBAL_OPTIONS=local_certs -e CADDY_ENV=rehearsal -e CADDY_TLS=auto \
  -e CF_TRUSTED_RANGES=127.0.0.1/32 nesto-caddy:check caddy adapt --config /etc/caddy/Caddyfile
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
  (120 events per minute per `{client_ip}`) on `/api/payments/webhook` and
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
no default position). Behind a proxy the key must be the real client address: 9c uses
`{client_ip}` with `trusted_proxies` (see "Behind Cloudflare"); `{remote_host}` would be
Cloudflare's address, and every caller would share one bucket.

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
