import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { LucideSearch } from '@lucide/angular';
import { Subject, catchError, debounceTime, distinctUntilChanged, filter, map, of, switchMap } from 'rxjs';
import type { SearchSuggestions } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { formatPrice } from '../core/format';
import { ResponsiveImage } from '../catalog/responsive-image';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;
const MAX_PRODUCTS = 6;
const MAX_CATEGORIES = 4;

interface Option {
  id: string;
  url: string;
}

/**
 * Header search with autocomplete (SRC-01, BRAND §9.4). A plain GET form to /search, so it works
 * without JavaScript; with JavaScript it suggests products and categories after 200 ms and two
 * characters (combobox + listbox pattern). The dropdown is never rendered on the server.
 */
@Component({
  selector: 'hg-search-box',
  imports: [RouterLink, LucideSearch, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search-box.html',
  styleUrl: './search-box.scss',
  host: { '(document:click)': 'documentClick($event)', '(focusout)': 'focusOut($event)' },
})
export class SearchBox {
  /** Makes the input, listbox and option ids unique per instance. */
  readonly idPrefix = input.required<string>();

  private readonly api = inject(CatalogApi);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly typed$ = new Subject<string>();
  /** Set by Enter/Escape/navigation: drops pending (debounced or in-flight) results. */
  private dismissed = false;

  protected readonly text = signal('');
  protected readonly results = signal<SearchSuggestions | null>(null);
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  /** The query the shown results belong to. */
  protected readonly query = signal('');

  protected readonly products = computed(() => this.results()?.products.slice(0, MAX_PRODUCTS) ?? []);
  protected readonly categories = computed(() => this.results()?.categories.slice(0, MAX_CATEGORIES) ?? []);
  protected readonly count = computed(() => this.products().length + this.categories().length);

  protected readonly inputId = computed(() => `${this.idPrefix()}-input`);
  protected readonly listId = computed(() => `${this.idPrefix()}-list`);
  protected optionId(i: number) {
    return `${this.idPrefix()}-opt-${i}`;
  }

  /** Every selectable row in order: products, categories, then "all results". */
  protected readonly options = computed<Option[]>(() => {
    const urls = [
      ...this.products().map((p) => `/product/${p.slug}`),
      ...this.categories().map((c) => `/category/${c.slug}`),
      `/search?q=${encodeURIComponent(this.query())}`,
    ];
    return urls.map((url, i) => ({ id: this.optionId(i), url }));
  });
  protected readonly activeId = computed(() => this.options()[this.activeIndex()]?.id ?? null);

  constructor() {
    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      this.typed$
        .pipe(
          map((v) => v.trim()),
          debounceTime(DEBOUNCE_MS),
          filter(() => !this.dismissed),
          distinctUntilChanged(),
          switchMap((q) =>
            q.length < MIN_CHARS
              ? of({ q, data: null })
              : this.api.suggest(q).pipe(
                  map((data) => ({ q, data })),
                  catchError(() => of({ q, data: null })),
                ),
          ),
          takeUntilDestroyed(inject(DestroyRef)),
        )
        .subscribe(({ q, data }) => {
          if (this.dismissed) return;
          this.query.set(q);
          this.results.set(data);
          this.activeIndex.set(-1);
          this.open.set(data !== null);
        });
    }
  }

  protected typing(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    this.dismissed = false;
    if (value.trim().length < MIN_CHARS) this.close(false);
    this.typed$.next(value);
  }

  protected keydown(event: KeyboardEvent) {
    const n = this.options().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!this.open()) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const cur = this.activeIndex();
        this.activeIndex.set(cur < 0 ? (step > 0 ? 0 : n - 1) : (cur + step + n) % n);
        return;
      }
      case 'Escape':
        if (this.open()) this.close(true);
        return;
      case 'Enter': {
        event.preventDefault();
        const active = this.open() ? this.options()[this.activeIndex()] : undefined;
        if (active) {
          this.close(true);
          void this.router.navigateByUrl(active.url);
        } else {
          this.submit();
        }
        return;
      }
    }
  }

  /** A submit that did not come from the Enter key (e.g. a phone's "search" key). */
  protected formSubmit(event: Event) {
    event.preventDefault();
    this.submit();
  }

  private submit() {
    const q = this.text().trim();
    if (!q) return;
    this.close(true);
    this.host.nativeElement.querySelector('input')?.blur();
    void this.router.navigate(['/search'], { queryParams: { q } });
  }

  /** `dismiss` also drops requests that are still pending. */
  private close(dismiss: boolean) {
    if (dismiss) this.dismissed = true;
    this.open.set(false);
    this.activeIndex.set(-1);
  }

  protected focusIn() {
    if (this.results() && !this.dismissed && this.text().trim() === this.query()) this.open.set(true);
  }

  protected focusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !this.host.nativeElement.contains(next)) this.close(false);
  }

  protected documentClick(event: Event) {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }

  protected price(agorot: number) {
    return formatPrice(agorot);
  }

  protected linkClick() {
    this.close(true);
  }
}
