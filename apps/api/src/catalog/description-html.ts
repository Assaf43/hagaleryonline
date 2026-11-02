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
  return sanitizeHtml(html.replace(/<\/?(p|br|h3|li)[^>]*>/gi, ' '), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
