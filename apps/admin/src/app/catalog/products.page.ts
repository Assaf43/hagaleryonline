import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { LucidePlus, LucideSearch } from '@lucide/angular';
import type { AdminProductPage, CatalogStructure, ProductStatusFilter } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { categoryOptions, formatPrice } from './catalog-format';

/** Product list (ADM-02): search, filter by category and status; cards, so it works on a phone. Filters live in the URL. */
@Component({
  selector: 'hga-products-page',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    LucidePlus,
    LucideSearch,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div>
        <h1>מוצרים</h1>
        <p class="page-intro">מוצר חדש נשמר מוסתר, ומופיע באתר רק אחרי שמסמנים אותו "מוצג באתר".</p>
      </div>
      @if (canEdit()) {
        <a matButton="filled" routerLink="/catalog/products/new">
          <svg lucidePlus></svg>
          מוצר חדש
        </a>
      }
    </header>

    <form class="filters" (ngSubmit)="search()">
      <mat-form-field class="filter-q">
        <mat-label>חיפוש לפי שם, שם דגם או מק"ט</mat-label>
        <input matInput name="q" [(ngModel)]="q" />
        <button matIconButton matSuffix type="submit" aria-label="חיפוש"><svg lucideSearch></svg></button>
      </mat-form-field>
      <mat-form-field>
        <mat-label>קטגוריה</mat-label>
        <mat-select name="categoryId" [(ngModel)]="categoryId" (selectionChange)="search()">
          <mat-option [value]="null">הכול</mat-option>
          @for (c of categories(); track c.id) {
            <mat-option [value]="c.id">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>מצב</mat-label>
        <mat-select name="status" [(ngModel)]="status" (selectionChange)="search()">
          <mat-option value="all">הכול</mat-option>
          <mat-option value="active">מוצגים באתר</mat-option>
          <mat-option value="hidden">מוסתרים</mat-option>
        </mat-select>
      </mat-form-field>
    </form>

    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }

    @if (data(); as d) {
      <p class="muted" aria-live="polite">{{ d.total }} מוצרים</p>
      <ul class="product-list">
        @for (p of d.items; track p.id) {
          <li>
            <a class="product-card" [routerLink]="['/catalog/products', p.id]">
              <span class="product-main">
                <span class="product-name">
                  <bdi dir="ltr" class="model">{{ p.modelName }}</bdi>
                  {{ p.nameHe }}
                </span>
                <span class="muted">{{ categoryName(p.categoryId) }}</span>
              </span>
              <span class="product-meta">
                <span class="badge" [class.badge-active]="p.active">{{ p.active ? 'מוצג באתר' : 'מוסתר' }}</span>
                <span>החל מ-{{ price(p.priceFrom) }}</span>
                <span>{{ p.variantCount }} וריאנטים · מלאי {{ p.totalStock }}</span>
                <span class="muted">עודכן {{ p.updatedAt | date: 'd.M.yyyy HH:mm' }}</span>
              </span>
            </a>
          </li>
        } @empty {
          <li class="muted">לא נמצאו מוצרים.</li>
        }
      </ul>
      @if (d.total > d.pageSize) {
        <div class="pager">
          <button matButton="outlined" type="button" [disabled]="d.page === 1" (click)="go(d.page - 1)">הקודם</button>
          <span class="muted">עמוד {{ d.page }} מתוך {{ pages(d) }}</span>
          <button matButton="outlined" type="button" [disabled]="d.page >= pages(d)" (click)="go(d.page + 1)">
            הבא
          </button>
        </div>
      }
    } @else if (!error()) {
      <p class="page-intro">טוען…</p>
    }
  `,
  styles: `
    .filters {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      gap: 0 var(--space-3);
    }

    @media (width < 720px) {
      .filters {
        grid-template-columns: 1fr;
      }
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .product-list {
      list-style: none;
      margin: var(--space-2) 0 0;
      padding: 0;
      display: grid;
      gap: var(--space-2);
    }

    .product-card {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2) var(--space-4);
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      color: inherit;
      text-decoration: none;
    }

    .product-card:hover,
    .product-card:focus-visible {
      border-color: var(--color-accent);
    }

    .product-main {
      display: grid;
      gap: var(--space-1);
    }

    .product-name {
      font-weight: 600;
    }

    .model {
      color: var(--color-accent);
      margin-inline-end: var(--space-2);
    }

    .product-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-3);
      font-size: var(--font-small);
    }

    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      margin-block-start: var(--space-4);
    }

    .page-head svg,
    .filters svg {
      inline-size: 18px;
      block-size: 18px;
    }
  `,
})
export class ProductsPage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  protected readonly structure = signal<CatalogStructure | null>(null);
  protected readonly data = signal<AdminProductPage | null>(null);
  protected readonly error = signal('');
  protected readonly categories = computed(() => categoryOptions(this.structure()?.categories ?? []));
  protected readonly canEdit = computed(() => this.auth.me()?.permissions.includes('catalog.edit') ?? false);

  protected q = '';
  protected categoryId: number | null = null;
  protected status: ProductStatusFilter = 'all';
  private page = 1;

  ngOnInit() {
    this.route.queryParamMap.subscribe((params) => {
      this.q = params.get('q') ?? '';
      this.categoryId = params.has('categoryId') ? Number(params.get('categoryId')) : null;
      this.status = (params.get('status') as ProductStatusFilter) ?? 'all';
      this.page = Number(params.get('page') ?? 1) || 1;
      void this.load();
    });
    this.api.structure().then(
      (s) => this.structure.set(s),
      (e) => this.error.set(errorMessage(e)),
    );
  }

  search() {
    this.navigate(1);
  }

  go(page: number) {
    this.navigate(page);
  }

  categoryName(id: number): string {
    return this.categories().find((c) => c.id === id)?.label ?? '';
  }

  price(agorot: number | null) {
    return formatPrice(agorot);
  }

  pages(d: AdminProductPage) {
    return Math.ceil(d.total / d.pageSize);
  }

  private navigate(page: number) {
    void this.router.navigate([], {
      queryParams: {
        q: this.q.trim() || null,
        categoryId: this.categoryId,
        status: this.status === 'all' ? null : this.status,
        page: page > 1 ? page : null,
      },
    });
  }

  private async load() {
    try {
      this.data.set(
        await this.api.products({
          q: this.q.trim() || undefined,
          categoryId: this.categoryId ?? undefined,
          status: this.status,
          page: this.page,
        }),
      );
      this.error.set('');
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
