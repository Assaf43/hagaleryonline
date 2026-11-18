import { previewNoStore } from './preview-no-store';

describe('previewNoStore', () => {
  const run = (query: Record<string, unknown>) => {
    const headers: Record<string, string> = {};
    const next = vi.fn();
    previewNoStore({ query }, { setHeader: (n, v) => (headers[n] = v) }, next);
    return { headers, next };
  };

  it('marks a ?preview= response no-store', () => {
    const { headers, next } = run({ preview: 'tok.1.sig' });
    expect(headers['Cache-Control']).toBe('no-store');
    expect(next).toHaveBeenCalled();
  });

  it('leaves other responses alone', () => {
    const { headers, next } = run({ sort: 'price_asc' });
    expect(headers['Cache-Control']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
