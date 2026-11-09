import { RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { PageMeta } from './page-meta';

describe('PageMeta', () => {
  const setup = () => {
    const response: { status?: number } = {};
    TestBed.configureTestingModule({ providers: [{ provide: RESPONSE_INIT, useValue: response }] });
    return { meta: TestBed.inject(PageMeta), response, tags: TestBed.inject(Meta) };
  };

  it('notFound answers 404 and is not indexed', () => {
    const { meta, response, tags } = setup();
    meta.notFound();
    expect(response.status).toBe(404);
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });

  it('serverError answers 503 and is not indexed', () => {
    const { meta, response, tags } = setup();
    meta.serverError();
    expect(response.status).toBe(503);
    expect(tags.getTag('name="robots"')?.content).toBe('noindex, follow');
  });
});
