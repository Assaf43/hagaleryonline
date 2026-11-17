import { descriptionText, isSafeContentLink, sanitizeContentHtml, sanitizeDescription } from './description-html.js';

describe('sanitizeDescription unchanged', () => {
  it('keeps the basic formatting and drops everything else', () => {
    expect(
      sanitizeDescription(
        '<h1>כותרת</h1><p style="color:red" onclick="x()">טקסט <i>נטוי</i></p><script>alert(1)</script><img src=x>',
      ),
    ).toBe('<h3>כותרת</h3><p>טקסט <em>נטוי</em></p>');
  });

  it('turns every heading into h3 and keeps br and lists', () => {
    expect(sanitizeDescription('<h2>א</h2><h4>ב</h4><p>ג<br>ד</p><ol><li>ה</li></ol><ul><li><b>ו</b></li></ul>')).toBe(
      '<h3>א</h3><h3>ב</h3><p>ג<br />ד</p><ol><li>ה</li></ol><ul><li><strong>ו</strong></li></ul>',
    );
  });

  it('allows https, http and mailto links and marks them nofollow', () => {
    expect(sanitizeDescription('<p><a href="https://example.com" rel="x">קישור</a></p>')).toBe(
      '<p><a href="https://example.com" rel="nofollow noopener">קישור</a></p>',
    );
    expect(sanitizeDescription('<p><a href="http://example.com">קישור</a></p>')).toBe(
      '<p><a href="http://example.com" rel="nofollow noopener">קישור</a></p>',
    );
    expect(sanitizeDescription('<p><a href="mailto:a@example.test">מייל</a></p>')).toBe(
      '<p><a href="mailto:a@example.test" rel="nofollow noopener">מייל</a></p>',
    );
  });

  it('turns unsafe or relative links into plain text', () => {
    expect(sanitizeDescription('<p><a href="javascript:alert(1)">רע</a></p>')).toBe('<p>רע</p>');
    expect(sanitizeDescription('<p><a href="/info/shipping">פנימי</a></p>')).toBe('<p>פנימי</p>');
    expect(sanitizeDescription('<p><a href="tel:+97231234567">טלפון</a></p>')).toBe('<p>טלפון</p>');
  });

  it('treats an empty editor as no description', () => {
    expect(sanitizeDescription('<p></p>')).toBe('');
    expect(sanitizeDescription('  <p> </p> ')).toBe('');
  });

  it('gives search the words without tags', () => {
    expect(descriptionText('<h3>מידות</h3><ul><li>רוחב&nbsp;300</li><li>A &amp; B</li></ul>')).toBe(
      'מידות רוחב 300 A & B',
    );
  });
});

describe('isSafeContentLink', () => {
  it.each([
    'https://example.com',
    'https://example.com/a?b=1#c',
    'mailto:service@example.test',
    'tel:+97231234567',
    'tel:03-1234567',
    '/info/shipping',
    '/',
    '/search?q=ספה',
  ])('accepts %s', (href) => expect(isSafeContentLink(href)).toBe(true));

  it.each([
    '',
    'http://example.com',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:x',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://',
    'https:///evil',
    ' https://example.com',
    'https://exa mple.com',
    'info/shipping',
    'ftp://example.com',
    'tel:abc',
    'https://good.example@evil.example',
    'https://a@b',
    'https://good.example:x@evil.example/path',
  ])('refuses %j', (href) => expect(isSafeContentLink(href)).toBe(false));
});

describe('sanitizeContentHtml strips hostile input', () => {
  it('removes scripts, event handlers, styles, iframes and images', () => {
    expect(
      sanitizeContentHtml(
        '<p style="color:red" onclick="x()">שלום</p><script>alert(1)</script><img src=x onerror="alert(1)"><iframe src="https://evil.example"></iframe><style>p{}</style>',
        'page',
      ),
    ).toBe('<p>שלום</p>');
  });

  it('turns unsafe links into plain text', () => {
    const cases = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '&#106;avascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      '//evil.example',
      '/\\evil.example',
      'http://example.com',
      'vbscript:x',
      'https://good.example@evil.example',
    ];
    for (const href of cases) {
      expect(sanitizeContentHtml(`<p><a href="${href}" onclick="x()">קישור</a></p>`, 'page')).toBe('<p>קישור</p>');
    }
  });

  it('keeps tel, mailto and site-path links with only an href, and marks https links noopener', () => {
    expect(
      sanitizeContentHtml(
        '<p><a href="tel:+97231234567" target="_blank" rel="opener">טלפון</a> <a href="mailto:service@example.test" class="x">מייל</a> <a href="/info/shipping" title="t">משלוחים</a> <a href="https://example.com" target="_blank" rel="opener">חוץ</a></p>',
        'page',
      ),
    ).toBe(
      '<p><a href="tel:+97231234567">טלפון</a> <a href="mailto:service@example.test">מייל</a> <a href="/info/shipping">משלוחים</a> <a href="https://example.com" rel="noopener">חוץ</a></p>',
    );
  });

  it('page mode keeps h2 and h3 and the basic formatting', () => {
    expect(
      sanitizeContentHtml(
        '<h1>א</h1><h2>ב</h2><h3>ג</h3><h4>ד</h4><p><b>ה</b> <i>ו</i><br>ז</p><ul><li>ח</li></ul><ol><li>ט</li></ol><div>י</div><span>כ</span>',
        'page',
      ),
    ).toBe(
      '<h2>א</h2><h2>ב</h2><h3>ג</h3><h3>ד</h3><p><strong>ה</strong> <em>ו</em><br />ז</p><ul><li>ח</li></ul><ol><li>ט</li></ol>יכ',
    );
  });

  it('does not treat a body of only an h2 heading as empty', () => {
    expect(sanitizeContentHtml('<h2>כותרת</h2>', 'page')).toBe('<h2>כותרת</h2>');
    expect(descriptionText('<h2>כותרת</h2><p>טקסט</p>')).toBe('כותרת טקסט');
  });

  it('inline mode turns every heading into a paragraph', () => {
    expect(sanitizeContentHtml('<h2>כותרת</h2><h3>משנה</h3><h1>ראשית</h1><p>טקסט</p>', 'inline')).toBe(
      '<p>כותרת</p><p>משנה</p><p>ראשית</p><p>טקסט</p>',
    );
  });

  it('treats an empty editor as empty', () => {
    expect(sanitizeContentHtml('<p></p>', 'page')).toBe('');
    expect(sanitizeContentHtml('<p><br></p>', 'inline')).toBe('');
    expect(sanitizeContentHtml('<script>x</script>', 'page')).toBe('');
  });
});
