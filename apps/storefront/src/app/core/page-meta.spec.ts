import { RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { PageMeta } from './page-meta';
import { SEO_INDEXING } from './server-tokens';

describe('PageMeta', () => {
  const setup = (indexing = true) => {
    const response: { status?: number } = {};
    TestBed.configureTestingModule({
      providers: [
        { provide: RESPONSE_INIT, useValue: response },
        { provide: SEO_INDEXING, useValue: indexing },
      ],
    });
    return { meta: TestBed.inject(PageMeta), response, tags: TestBed.inject(Meta) };
  };

  it('notFound answers 404 and is not indexed', () => {
    const { meta, response, tags } = setup();
    meta.notFound();
    expect(response.status).toBe(404);
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('replaces and clears the json-ld script', () => {
    const { meta } = setup();
    const ld = () => document.head.querySelectorAll('script#ld[type="application/ld+json"]');
    const page = { title: 't', description: 'd', path: '/x' };
    meta.set({ ...page, jsonLd: { a: '</script>' } });
    expect(ld().length).toBe(1);
    expect(ld()[0].textContent).toBe('{"a":"\\u003c/script>"}');
    meta.set({ ...page, jsonLd: [{ b: 1 }] });
    expect(ld().length).toBe(1);
    expect(ld()[0].textContent).toBe('[{"b":1}]');
    meta.set(page);
    expect(ld().length).toBe(0);
    meta.set({ ...page, jsonLd: { c: 1 } });
    meta.notFound();
    expect(ld().length).toBe(0);
    meta.set({ ...page, jsonLd: { c: 1 } });
    meta.serverError();
    expect(ld().length).toBe(0);
  });

  it('serverError answers 503 and is not indexed', () => {
    const { meta, response, tags } = setup();
    meta.serverError();
    expect(response.status).toBe(503);
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('indexes normal pages and keeps noindex pages out when indexing is on', () => {
    const { meta, tags } = setup(true);
    meta.set({ title: 't', description: 'd', path: '/x' });
    expect(tags.getTag('name="robots"')?.content).toBe('index, follow');
    meta.set({ title: 't', description: 'd', path: '/x', noindex: true });
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('PageMeta forces noindex when indexing is off', () => {
    const { meta, tags } = setup(false);
    meta.set({ title: 't', description: 'd', path: '/x' });
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('indexing is off by default', () => {
    TestBed.configureTestingModule({});
    TestBed.inject(PageMeta).set({ title: 't', description: 'd', path: '/x' });
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex, follow');
  });
});
