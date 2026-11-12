import { BRAND } from '@hg/models';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML (customer names and product names are data, never markup). */
export const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** An order number or a code inside Hebrew text keeps its direction. */
export const bdi = (value: string | number): string => `<bdi>${esc(value)}</bdi>`;

/** E-mail clients ignore external CSS and custom properties: every style is inline, with literal values. */
export const PARA = 'margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;';
export const BUTTON =
  'display:inline-block;padding:12px 24px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:4px;font-size:16px;';

/** The RTL HTML shell shared by every e-mail: brand header, the content, a quiet footer. */
export function emailLayout(title: string, content: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
</head>
<body dir="rtl" style="margin:0;padding:0;background:#f4f4f4;font-family:Assistant,Arial,Helvetica,sans-serif;">
<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e5e5e5;font-size:22px;font-weight:700;letter-spacing:2px;color:#1a1a1a;">${esc(BRAND.name)}</td></tr>
<tr><td style="padding:32px;text-align:right;">
${content}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e5e5;font-size:13px;color:#666666;">${esc(BRAND.nameHe)} · ${esc(BRAND.tagline)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export const paragraph = (html: string): string => `<p style="${PARA}">${html}</p>`;

export const button = (href: string, label: string): string =>
  `<p style="margin:24px 0;"><a href="${esc(href)}" style="${BUTTON}">${esc(label)}</a></p>`;

export const greeting = (name: string | undefined): string =>
  paragraph(name?.trim() ? `שלום ${esc(name.trim())},` : 'שלום,');
