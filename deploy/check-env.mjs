#!/usr/bin/env node
// Cross-checks of one production / staging / rehearsal env file (spec 9c, NFR-12), run by deploy/deploy.sh as step 0
// inside nesto-app:<tag> before anything changes:
//   docker run --rm -i --network none -v <env-file>:/env:ro -v <compose-file>:/compose.yml:ro nesto-app:<tag> \
//     -v <deploy/cloudflare-ips.txt>:/cloudflare-ips.txt:ro nesto-app:<tag> node - /env /compose.yml /cloudflare-ips.txt
// or from the host: node deploy/check-env.mjs <env-file> [compose-file [cloudflare-ips-file]]   (defaults: the
// docker-compose.prod.yml at the repo root and deploy/cloudflare-ips.txt beside this script; run from stdin without a
// third argument, CF_TRUSTED_RANGES is checked for CIDR syntax only). Plain Node with no dependencies and no import / export, so it runs from stdin as well as from a file.
// It never prints a value, only variable names and rules. Exit 0 = ok, 1 = problems (all listed), 2 = usage or
// unreadable input. The API checks each value on its own at startup (apps/api/src/config/production-env.ts); this
// file checks what only the whole file can tell: the hosts agree, TRUST_PROXY is the edge network, the Caddy mode fits the app.

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

/** Compose env-file syntax: `NAME=value`, `export NAME=value`, `#` comments, '…' / "…" quotes, ` #` after a value. */
function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0)
      value = value.slice(1, value.indexOf(quote, 1));
    else value = value.replace(/\s+#.*$/, '').trim();
    env[match[1]] = value;
  }
  return env;
}

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
function check(env, subnet, cloudflare) {
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
    // Caddy believes the client IP header only from these ranges; staging and production sit behind Cloudflare.
    if (caddy === 'production' || caddy === 'staging') {
      const ranges = get('CF_TRUSTED_RANGES').split(/\s+/).filter(Boolean);
      if (!ranges.length) problems.push('CF_TRUSTED_RANGES: missing');
      else if (ranges.some((range) => !isCidr(range))) problems.push('CF_TRUSTED_RANGES: every entry must be a CIDR');
      else if (cloudflare && ranges.some((range) => !cloudflare.includes(range)))
        problems.push('CF_TRUSTED_RANGES: every entry must be listed in deploy/cloudflare-ips.txt');
    }
    if (caddy === 'staging')
      for (const name of ['STAGING_AUTH_USER', 'STAGING_AUTH_HASH'])
        if (!get(name)) problems.push(`${name}: required when CADDY_ENV=staging`);
  }
  if (get('CADDY_TLS') && !CADDY_TLS_MODES.includes(get('CADDY_TLS')))
    problems.push('CADDY_TLS: must be origin or auto');
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
