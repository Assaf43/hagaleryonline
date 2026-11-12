import type { ConfigService } from '@nestjs/config';

const DEV_SITE = 'http://localhost:4200';

/**
 * The public site address for links in messages, without a trailing slash: `SITE_URL`, else `STOREFRONT_URL`.
 * Read once at startup. In production one of them is required (a localhost link in a customer's e-mail or SMS is a
 * dead link), and any value must be an absolute http(s) URL with no query or fragment.
 */
export function resolveSiteUrl(config: ConfigService): string {
  const raw = config.get<string>('SITE_URL')?.trim() || config.get<string>('STOREFRONT_URL')?.trim();
  if (!raw) {
    if (config.get<string>('NODE_ENV') === 'production') {
      throw new Error('SITE_URL is not set: message links need the public site address in production.');
    }
    return DEV_SITE;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL "${raw}" is not an absolute URL (expected e.g. https://hagaleryonline.co.il).`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash) {
    throw new Error(`SITE_URL "${raw}" must be an http(s) address with no query or fragment.`);
  }
  return raw.replace(/\/+$/, '');
}
