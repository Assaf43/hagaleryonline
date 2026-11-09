import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  PendingTasks,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { combineLatest } from 'rxjs';
import { LucideChevronLeft, LucideSlidersHorizontal, LucideX } from '@lucide/angular';
import { BRAND } from '@hg/models';
import type { ImageRef, ProductCard as Card, ProductListResponse, ProductSort } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { SITE_ORIGIN } from '../core/server-tokens';
import { breadcrumbJsonLd, crumbItems } from '../core/structured-data';
import { productCount } from '../core/format';
import { MenuData } from '../layout/menu-data';
import { CatalogApi } from '../core/catalog.api';
import { FiltersPanel } from './filters-panel';
import {
  PAGE_SIZE,
  SORT_LABELS,
  activeChips,
  clearFilters,
  filterCount,
  parseListing,
  setSort,
  toApiParams,
  toUrlParams,
  type ListingState,
} from './listing-state';
import { ProductCard } from './product-card';
import { ResponsiveImage } from './responsive-image';

export type ListingKind = 'category' | 'room' | 'search';

interface Heading {
  title: string;
  description: string;
  crumbs: { label: string; link: string[] | null }[];
  /** Sub-categories or a room's furniture types, as chips. */
  links: { label: string; slug: string; link: string[]; current: boolean }[];
}

/**
 * Category, room and search-results pages (CAT-01, CAT-03..CAT-10, NAV-03): product grid,
 * filters, active-filter chips, sort and "load more". The whole state lives in the URL (CAT-08),
 * so the server renders the same page a shared link shows.
 */
@Component({
  selector: 'hg-listing-page',
  imports: [
    RouterLink,
    FiltersPanel,
    ProductCard,
    ResponsiveImage,
    LucideChevronLeft,
    LucideSlidersHorizontal,
    LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './listing.page.html',
  styleUrl: './listing.page.scss',
})
export class ListingPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(CatalogApi);
  private readonly menu = inject(MenuData);
  private readonly meta = inject(PageMeta);
  private readonly origin = inject(SITE_ORIGIN);
  private readonly tasks = inject(PendingTasks);
  private readonly document = inject(DOCUMENT);
  private readonly filtersBox = viewChild<ElementRef<HTMLElement>>('filtersBox');
  private readonly filterButton = viewChild<ElementRef<HTMLButtonElement>>('filterButton');

  protected readonly kind = this.route.snapshot.data['kind'] as ListingKind;
  protected readonly state = signal<ListingState>(parseListing({}));
  protected readonly response = signal<ProductListResponse | null>(null);
  protected readonly items = signal<Card[]>([]);
  protected readonly heading = signal<Heading | null>(null);
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly notFound = signal(false);
  protected readonly filtersOpen = signal(false);
  /** A photo per furniture-type link, from the type's first product. */
  protected readonly linkImages = signal<Record<string, ImageRef | null>>({});

  protected readonly sorts = Object.entries(SORT_LABELS) as [ProductSort, string][];
  protected readonly chips = computed(() => activeChips(this.state(), this.response()?.facets ?? []));
  protected readonly filters = computed(() => filterCount(this.state()));
  protected readonly total = computed(() => this.response()?.total ?? 0);
  protected readonly hasMore = computed(() => this.items().length < this.total());
  protected readonly nextPage = computed(() => toUrlParams({ ...this.state(), page: this.state().page + 1 }));
  protected readonly count = productCount;

  /** Scope + filters + sort (no page): when it changes the list starts over. */
  private listKey = '';
  private scope: { category?: string; room?: string; q?: string } = {};
  private request = 0;

  constructor() {
    combineLatest([this.route.paramMap, this.route.queryParamMap])
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(([params, query]) => {
        const raw = Object.fromEntries(query.keys.map((k) => [k, query.get(k) ?? undefined]));
        const slug = params.get('slug') ?? '';
        const q = (query.get('q') ?? '').trim().slice(0, 100);
        this.scope = this.kind === 'search' ? { q } : { [this.kind]: slug };
        this.query.set(q);
        this.state.set(parseListing(raw));
        void this.tasks.run(() => this.load());
      });
    inject(DestroyRef).onDestroy(() => this.document.body.classList.remove('no-scroll'));
  }

  protected retry() {
    void this.tasks.run(() => this.load());
  }

  // ---------- Loading ----------

  private async load() {
    const request = ++this.request;
    const state = this.state();
    const key = JSON.stringify([this.scope, { ...state, page: 1 }]);
    const loaded = Math.ceil(this.items().length / PAGE_SIZE);
    const append = key === this.listKey && state.page === loaded + 1;
    // Pages to fetch: just the next one after "load more", else every page up to `page`.
    const pages = append ? [state.page] : Array.from({ length: state.page }, (_, i) => i + 1);

    this.loading.set(true);
    this.error.set(false);
    try {
      const [, ...results] = await Promise.all([
        this.menu.load(),
        ...pages.map((page) => this.api.products(toApiParams(state, this.scope, page))),
      ]);
      if (request !== this.request) return;
      const heading = this.buildHeading();
      if (!heading) {
        this.notFound.set(true);
        this.meta.notFound();
        return;
      }
      this.notFound.set(false);
      this.heading.set(heading);
      await this.loadLinkImages(heading);
      if (request !== this.request) return;
      this.listKey = key;
      const items = results.flatMap((r) => r.items);
      this.items.set(append ? [...this.items(), ...items] : items);
      this.response.set(results[results.length - 1]);
      this.setMeta(heading);
    } catch {
      if (request === this.request) this.error.set(true);
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  private async loadLinkImages(heading: Heading) {
    const known = this.linkImages();
    const missing = heading.links.map((l) => l.slug).filter((slug) => !(slug in known));
    if (!missing.length) return;
    const found = await Promise.all(
      missing.map((category) =>
        this.api.products({ category, pageSize: '1' }).then(
          (r) => [category, r.items[0]?.image ?? null] as const,
          () => [category, null] as const,
        ),
      ),
    );
    this.linkImages.update((images) => ({ ...images, ...Object.fromEntries(found) }));
  }

  private buildHeading(): Heading | null {
    const home = { label: 'דף הבית', link: ['/'] };
    if (this.kind === 'search') {
      const q = this.query();
      return {
        title: q ? `תוצאות חיפוש: ${q}` : 'חיפוש',
        description: `תוצאות חיפוש ב-${BRAND.name}${q ? ` עבור "${q}"` : ''}.`,
        crumbs: [home, { label: 'חיפוש', link: null }],
        links: [],
      };
    }
    if (this.kind === 'room') {
      const room = this.menu.rooms().find((r) => r.slug === this.scope.room);
      if (!room) return null;
      return {
        title: room.nameHe,
        description: `רהיטים ל${room.nameHe}: ${room.categories.map((c) => c.nameHe).join(', ')}. מידות מלאות לכל דגם ומשלוח עד הבית.`,
        crumbs: [home, { label: room.nameHe, link: null }],
        links: room.categories.map((c) => ({
          label: c.nameHe,
          slug: c.slug,
          link: ['/category', c.slug],
          current: false,
        })),
      };
    }
    const path = this.menu.pathTo(this.scope.category ?? '');
    if (!path.length) return null;
    const node = path[path.length - 1];
    const parent = path.length > 1 ? path[path.length - 2] : null;
    // Sub-types of this category, or its siblings when it is a sub-type.
    const group = node.children.length ? node : parent;
    const links = group
      ? [
          { label: `כל ה${group.nameHe}`, slug: group.slug, link: ['/category', group.slug], current: group === node },
          ...group.children.map((c) => ({
            label: c.nameHe,
            slug: c.slug,
            link: ['/category', c.slug],
            current: c === node,
          })),
        ]
      : [];
    return {
      title: node.nameHe,
      description: `${node.nameHe} ב-${BRAND.name}: מידות מלאות לכל דגם, סינון לפי רוחב ועומק, ומשלוח עד הבית.`,
      crumbs: [
        home,
        ...path.map((c, i) => ({ label: c.nameHe, link: i < path.length - 1 ? ['/category', c.slug] : null })),
      ],
      links,
    };
  }

  private setMeta(heading: Heading) {
    const s = this.state();
    const path =
      this.kind === 'search'
        ? '/search'
        : `/${this.kind}/${this.kind === 'room' ? this.scope.room : this.scope.category}`;
    // Same crumbs as the page shows; the current one (no link) is this page. Search has none.
    const jsonLd = this.kind === 'search' ? undefined : breadcrumbJsonLd(crumbItems(heading.crumbs, path, this.origin));
    this.meta.set({
      title: heading.title,
      description: heading.description,
      path,
      jsonLd,
      image: this.items()[0]?.image?.url,
      // Filtered, sorted, paged and search views point search engines to the plain page.
      noindex: this.kind === 'search' || filterCount(s) > 0 || s.sort !== 'recommended' || s.page > 1,
    });
  }

  // ---------- Changes ----------

  protected apply(state: ListingState) {
    void this.router.navigate([], { relativeTo: this.route, queryParams: this.withQuery(toUrlParams(state)) });
  }

  protected sortChanged(sort: string) {
    this.apply(setSort(this.state(), sort as ProductSort));
  }

  protected clearAll() {
    this.apply(clearFilters(this.state()));
  }

  /** "Load more" is a real link (crawlable, works before hydration); in the app it appends. */
  protected loadMore(event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.urlFor(this.nextPage()),
      replaceUrl: true,
    });
  }

  protected urlFor(params: Record<string, string>) {
    return this.withQuery(params);
  }

  private withQuery(params: Record<string, string>) {
    return this.kind === 'search' ? { q: this.query(), ...params } : params;
  }

  // ---------- Filters drawer (phones and tablets) ----------

  protected openFilters() {
    this.filtersOpen.set(true);
    this.document.body.classList.add('no-scroll');
    setTimeout(() => this.filtersBox()?.nativeElement.querySelector<HTMLElement>('.drawer-close')?.focus());
  }

  protected closeFilters() {
    if (!this.filtersOpen()) return;
    this.filtersOpen.set(false);
    this.document.body.classList.remove('no-scroll');
    this.filterButton()?.nativeElement.focus();
  }
}
