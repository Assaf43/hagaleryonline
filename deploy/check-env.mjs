#!/usr/bin/env node
// Cross-checks of one production / staging / rehearsal env file (spec 9c, NFR-12), run by deploy/deploy.sh as step 1b
// inside nesto-app:<tag> before anything changes, with the script on stdin:
//   docker run --rm -i --pull never --network none --read-only --cap-drop ALL --user "$(id -u):$(id -g)" \
//     -v <env-file>:/env:ro -v <repo>/docker-compose.prod.yml:/compose.yml:ro \
//     -v <repo>/deploy/cloudflare-ips.txt:/cloudflare-ips.txt:ro \
//     nesto-app:<tag> node - /env /compose.yml /cloudflare-ips.txt < deploy/check-env.mjs
// or from the host: node deploy/check-env.mjs <env-file> [compose-file [cloudflare-ips-file]]   (defaults: the
// docker-compose.prod.yml at the repo root and deploy/cloudflare-ips.txt beside this script; run from stdin without a
// third argument, CF_TRUSTED_RANGES is checked for CIDR syntax only). Plain Node with no dependencies and no import /
// export, so it runs from stdin as well as from a file.
// It never prints a value, only variable names and rules. Exit 0 = ok, 1 = problems (all listed), 2 = usage or
// unreadable input. The API checks each value on its own at startup (apps/api/src/config/production-env.ts); this
// file checks what only the whole file can tell: the hosts agree, TRUST_PROXY is the edge network, the Caddy mode and
// TLS source fit the app, and STAGING_AUTH_HASH survives Compose's `$` interpolation.

const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const CADDY_ENVS = ['production', 'staging', 'rehearsal'];
const CADDY_TLS_MODES = ['origin', 'auto'];

/** The CIDRs of a cloudflare-ips file (one per line, `#` comments). */
function parseCidrList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** `a.b.c.d/n` (n 0-32) or an IPv6 `x:y::z/n` (n 0-128): syntax only. */
function isCidr(value) {
  const match = /^([0-9A-Fa-f.:]+)\/(\d{1,3})$/.exec(value);
  if (!match) return false;
  const bits = Number(match[2]);
  if (match[1].includes(':')) return bits <= 128 && /^[0-9A-Fa-f:]+$/.test(match[1]);
  const parts = match[1].split('.');
  return bits <= 32 && parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Compose env-file syntax: `NAME=value`, `export NAME=value`, `#` comments, '…' / "…" quotes, ` #` after a value.
 * Returns the values (quotes removed, `$` left as written) and, per name, the quote it was written in ('', "'" or
 * '"'): Compose interpolates `$` in unquoted and double-quoted values only.
 */
function parseEnvFile(text) {
  const env = {};
  const quotes = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
      quotes[match[1]] = quote;
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
      quotes[match[1]] = '';
    }
    env[match[1]] = value;
  }
  return { env, quotes };
}

/**
 * The value a container receives for a value Compose interpolates, or null when Compose would expand part of it:
 * single-quoted is literal; unquoted or double-quoted, `$$` is one `$` and any other `$` starts a variable.
 */
function composeValue(value, quote) {
  if (quote === "'") return value;
  if (value.replace(/\$\$/g, '').includes('$')) return null;
  return value.replace(/\$\$/g, '$');
}

/** A bcrypt hash as `caddy hash-password` prints it: $2a$ / $2b$ / $2y$, a cost of 04-31, 53 more characters. */
const BCRYPT = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

/** `localhost` or a name ending in `.localhost`. */
const isLocalhost = (host) => /^(?:[a-z0-9-]+\.)*localhost$/i.test(host);

/**
 * The subnet of the top-level `networks: edge:` entry of a compose file, by indentation (no YAML parser): the first
 * `subnet:` line nested under `edge:`. Null when there is none.
 */
function edgeSubnet(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, ''));
  const indent = (line) => /^ */.exec(line)[0].length;
  let inNetworks = false;
  let edgeIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indent(line) === 0) {
      inNetworks = /^networks:\s*$/.test(line);
      edgeIndent = -1;
      continue;
    }
    if (!inNetworks) continue;
    if (edgeIndent >= 0 && indent(line) <= edgeIndent) edgeIndent = -1;
    if (edgeIndent < 0) {
      if (/^\s+edge:\s*(\{\s*\})?\s*$/.test(line)) edgeIndent = indent(line);
      continue;
    }
    const subnet = /^\s+(?:-\s+)?subnet:\s*['"]?([0-9A-Fa-f.:/]+)['"]?\s*$/.exec(line);
    if (subnet) return subnet[1];
  }
  return null;
}

/** The lower-case host name of an URL, or null. */
function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** One line per problem (names and rules only). */
function check({ env, quotes }, subnet, cloudflare) {
  const problems = [];
  const get = (name) => (env[name] ?? '').trim();
  const need = (name) => {
    if (get(name)) return true;
    problems.push(`${name}: missing`);
    return false;
  };
  const sameHost = (hostName, urlName) => {
    if (!need(urlName)) return;
    const host = hostOf(get(urlName));
    if (!host) problems.push(`${urlName}: not a URL`);
    else if (get(hostName) && host !== get(hostName).toLowerCase())
      problems.push(`${hostName}: must be the host of ${urlName}`);
  };

  // Hosts: Caddy's site names, the URLs the API builds and the SSR's allowed hosts must be one and the same.
  const siteHost = need('SITE_HOST');
  if (need('NG_ALLOWED_HOSTS') && siteHost) {
    const allowed = get('NG_ALLOWED_HOSTS')
      .split(',')
      .map((host) => host.trim().toLowerCase());
    if (!allowed.includes(get('SITE_HOST').toLowerCase())) problems.push('NG_ALLOWED_HOSTS: must list SITE_HOST');
  }
  sameHost('SITE_HOST', 'SITE_URL');
  sameHost('SITE_HOST', 'STOREFRONT_URL');
  need('ADMIN_HOST');
  sameHost('ADMIN_HOST', 'ADMIN_URL');

  // Only Caddy's network may set X-Forwarded-For.
  if (need('TRUST_PROXY') && get('TRUST_PROXY') !== subnet)
    problems.push('TRUST_PROXY: must be the edge subnet of docker-compose.prod.yml (networks.edge)');

  // The Caddy mode, the app mode and indexing move together (Compose defaults APP_ENV to production, SEO_INDEXING to
  // false).
  const appProduction = (get('APP_ENV') || 'production') === 'production';
  if (need('CADDY_ENV')) {
    const caddy = get('CADDY_ENV');
    if (!CADDY_ENVS.includes(caddy)) problems.push('CADDY_ENV: must be production, staging or rehearsal');
    else if ((caddy === 'production') !== appProduction)
      problems.push('CADDY_ENV, APP_ENV: production on both or on neither');
    if (caddy === 'production' || caddy === 'staging') {
      // Caddy believes the client IP header only from these ranges; staging and production sit behind Cloudflare,
      // and the set must be exactly deploy/cloudflare-ips.txt (a refreshed list means a regenerated env file).
      const ranges = get('CF_TRUSTED_RANGES').split(/\s+/).filter(Boolean);
      if (!ranges.length) problems.push('CF_TRUSTED_RANGES: missing');
      else if (ranges.some((range) => !isCidr(range))) problems.push('CF_TRUSTED_RANGES: every entry must be a CIDR');
      else if (cloudflare) {
        const given = new Set(ranges.map((range) => range.toLowerCase()));
        const listed = new Set(cloudflare.map((range) => range.toLowerCase()));
        if ([...given].some((range) => !listed.has(range)))
          problems.push('CF_TRUSTED_RANGES: every entry must be listed in deploy/cloudflare-ips.txt');
        if ([...listed].some((range) => !given.has(range)))
          problems.push('CF_TRUSTED_RANGES: must hold every range of deploy/cloudflare-ips.txt');
      }
      // Cloudflare (Full strict) talks to the origin with its Origin CA certificate, never Caddy's own.
      if (get('CADDY_TLS') !== 'origin') problems.push(`CADDY_TLS: must be origin when CADDY_ENV=${caddy}`);
      const originDir = get('CADDY_ORIGIN_DIR').replace(/[\\/]+$/, '');
      if (!originDir || /(^|[\\/])no-origin$/.test(originDir))
        problems.push(`CADDY_ORIGIN_DIR: must be the Origin CA folder when CADDY_ENV=${caddy}`);
    }
    // The rehearsal is local only: localhost names and Caddy's own (local) certificates.
    if (caddy === 'rehearsal') {
      for (const name of ['SITE_HOST', 'ADMIN_HOST'])
        if (get(name) && !isLocalhost(get(name)))
          problems.push(`${name}: must be localhost or end in .localhost when CADDY_ENV=rehearsal`);
      if (get('CADDY_TLS') && get('CADDY_TLS') !== 'auto')
        problems.push('CADDY_TLS: must be auto (or empty) when CADDY_ENV=rehearsal');
    }
    if (caddy === 'staging')
      for (const name of ['STAGING_AUTH_USER', 'STAGING_AUTH_HASH'])
        if (!get(name)) problems.push(`${name}: required when CADDY_ENV=staging`);
  }
  if (get('CADDY_TLS') && !CADDY_TLS_MODES.includes(get('CADDY_TLS')))
    problems.push('CADDY_TLS: must be origin or auto');
  // A bcrypt hash is full of `$`: unquoted or in double quotes Compose expands `$2a`, `$14`, ... and Caddy gets a
  // stub. It must be in single quotes (or have every `$` doubled).
  if (get('STAGING_AUTH_HASH')) {
    const hash = composeValue(get('STAGING_AUTH_HASH'), quotes.STAGING_AUTH_HASH ?? '');
    if (hash === null)
      problems.push("STAGING_AUTH_HASH: Compose would expand its '$': write it in single quotes, or every '$' as '$$'");
    else if (!BCRYPT.test(hash)) problems.push('STAGING_AUTH_HASH: must be a bcrypt hash (caddy hash-password)');
  }
  if ((get('SEO_INDEXING') === 'true') !== appProduction)
    problems.push('SEO_INDEXING: true exactly when APP_ENV is production');
  return problems;
}

function main(argv) {
  const [envFile, composeArg, cloudflareArg] = argv;
  if (!envFile || argv.length > 3) {
    process.stderr.write('Usage: node deploy/check-env.mjs <env-file> [compose-file [cloudflare-ips-file]]\n');
    return 2;
  }
  // From a file: the compose file beside the repo root; from stdin (`node -`): the working directory's.
  const script = process.argv[1];
  const fromFile = script && script !== '-' && script.endsWith('check-env.mjs');
  const composeFile =
    composeArg ??
    (fromFile ? path.join(path.dirname(script), '..', 'docker-compose.prod.yml') : 'docker-compose.prod.yml');

  const cloudflareFile = cloudflareArg ?? (fromFile ? path.join(path.dirname(script), 'cloudflare-ips.txt') : null);

  let envText;
  let composeText;
  let cloudflare = null;
  try {
    envText = fs.readFileSync(envFile, 'utf8');
  } catch {
    process.stderr.write('check-env: cannot read the env file\n');
    return 2;
  }
  try {
    composeText = fs.readFileSync(composeFile, 'utf8');
  } catch {
    process.stderr.write('check-env: cannot read the compose file\n');
    return 2;
  }
  if (cloudflareFile) {
    try {
      cloudflare = parseCidrList(fs.readFileSync(cloudflareFile, 'utf8'));
    } catch {
      process.stderr.write('check-env: cannot read the Cloudflare ranges file\n');
      return 2;
    }
  }
  const subnet = edgeSubnet(composeText);
  if (!subnet) {
    process.stderr.write('check-env: could not read the edge subnet (networks.edge ... subnet:) of the compose file\n');
    return 2;
  }

  const problems = check(parseEnvFile(envText), subnet, cloudflare);
  if (problems.length) {
    process.stderr.write(`check-env: the env file has ${problems.length} problem(s):\n`);
    for (const line of problems) process.stderr.write(`- ${line}\n`);
    return 1;
  }
  process.stdout.write('check-env: ok\n');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
