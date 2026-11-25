# Caddy snippets

Reusable Caddyfile snippets for the production setup. Nothing runs Caddy yet:
Phase 9b builds the image and the Caddyfile and imports these files.

## Files

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
```

Validate syntax with `caddy fmt --diff` and `caddy adapt` before deploying.
