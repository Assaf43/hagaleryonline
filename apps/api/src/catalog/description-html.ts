import sanitizeHtml from 'sanitize-html';

/**
 * Product descriptions are rich text from the admin editor (decision 56): paragraphs, one heading
 * level, bold, italic, lists and links. Anything else (styles, colors, scripts, images) is removed,
 * so every product page looks the same and nothing unsafe reaches the storefront.
 */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'a'],
  // rel always comes from the link transform below, never from the input.
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  transformTags: {
    b: 'strong',
    i: 'em',
    h1: 'h3',
    h2: 'h3',
    h4: 'h3',
    // A link without a safe address becomes plain text (span is not allowed, so it is unwrapped).
    a: (_, attribs): sanitizeHtml.Tag =>
      SAFE_LINK.test(attribs['href'] ?? '')
        ? { tagName: 'a', attribs: { href: attribs['href'], rel: 'nofollow noopener' } }
        : { tagName: 'span', attribs: {} },
  },
};

export function sanitizeDescription(html: string): string {
  const clean = sanitizeHtml(html, OPTIONS).trim();
  // An editor left empty produces <p></p>.
  return descriptionText(clean) ? clean : '';
}

/** The words of a description, for search_text. */
export function descriptionText(html: string): string {
  // h2 occurs only in content texts (descriptions turn every heading into h3).
  return sanitizeHtml(html.replace(/<\/?(p|br|h2|h3|li)[^>]*>/gi, ' '), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Content texts (Phase 8, decision 99): info pages, FAQ answers, the product-page shipping text and landing-page
 * intros. A second options set next to the description one (which stays unchanged): `page` keeps h2 and h3; `inline`
 * has no headings (they become paragraphs). Links go only to https, mailto, tel or a site path (`/…`, never `//…`);
 * a link keeps only its address, and an https link gets rel="noopener".
 */
export type ContentHtmlMode = 'page' | 'inline';

const SITE_PATH = /^\/(?![/\\])/;
/** An https address with a host and no user info: the authority runs to the end or to the first `/`, `?` or `#`. */
const HTTPS_LINK = /^https:\/\/[^/?#\\@\s]+(?:[/?#]|$)/i;
const MAILTO_LINK = /^mailto:[^/\\]/i;
const TEL_LINK = /^tel:\+?[0-9][0-9-]*$/i;

/** True for an address a content link may point to: https, mailto, tel, or a site path starting with exactly one `/`. */
export function isSafeContentLink(href: string): boolean {
  // No spaces, control characters or backslashes anywhere (browsers read "/\host" as "//host").
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused here.
  if (!href || /[\s\\\u0000-\u001f\u007f]/.test(href)) return false;
  return HTTPS_LINK.test(href) || MAILTO_LINK.test(href) || TEL_LINK.test(href) || SITE_PATH.test(href);
}

/**
 * An unsafe link keeps its tag name but loses every attribute; `exclusiveFilter` then drops the tag and keeps its text.
 * (Renaming it to a disallowed tag, as descriptions do, leaves a stale entry in sanitize-html 2.18's close-tag map:
 * the next link at the same depth would be closed with `</span>`.)
 */
const contentLink = (_: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
  const href = attribs['href'] ?? '';
  if (!isSafeContentLink(href)) return { tagName: 'a', attribs: {} };
  return { tagName: 'a', attribs: HTTPS_LINK.test(href) ? { href, rel: 'noopener' } : { href } };
};

const contentOptions = (mode: ContentHtmlMode): sanitizeHtml.IOptions => {
  const page = mode === 'page';
  return {
    allowedTags: page
      ? ['p', 'br', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'a']
      : ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a'],
    // rel always comes from the link transform, never from the input.
    allowedAttributes: { a: ['href', 'rel'] },
    allowedSchemes: ['https', 'mailto', 'tel'],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    // Removed together with their content.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'template', 'svg', 'math'],
    transformTags: {
      b: 'strong',
      i: 'em',
      h1: page ? 'h2' : 'p',
      h2: page ? 'h2' : 'p',
      h3: page ? 'h3' : 'p',
      h4: page ? 'h3' : 'p',
      h5: page ? 'h3' : 'p',
      h6: page ? 'h3' : 'p',
      a: contentLink,
    },
    exclusiveFilter: (frame) => (frame.tag === 'a' && !frame.attribs['href'] ? 'excludeTag' : false),
  };
};

const CONTENT_OPTIONS: Record<ContentHtmlMode, sanitizeHtml.IOptions> = {
  page: contentOptions('page'),
  inline: contentOptions('inline'),
};

/** Sanitizes a content text before it is stored; an editor left empty gives ''. */
export function sanitizeContentHtml(html: string, mode: ContentHtmlMode): string {
  const clean = sanitizeHtml(html, CONTENT_OPTIONS[mode]).trim();
  return descriptionText(clean) ? clean : '';
}
