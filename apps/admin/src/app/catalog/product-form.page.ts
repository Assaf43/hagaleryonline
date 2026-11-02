import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  LucideArrowRight,
  LucideChevronDown,
  LucideChevronUp,
  LucideImage,
  LucidePlus,
  LucideSparkles,
  LucideTrash2,
} from '@lucide/angular';
import type {
  AdminAttribute,
  AdminProduct,
  AdminProductInput,
  AdminVariant,
  CatalogStructure,
  FulfillmentMode,
} from '@hg/models';
import { AuthService } from '../core/auth.service';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { FULFILLMENT_LABEL, categoryOptions, suggestSlug, toAgorot, toShekels } from './catalog-format';
import { RichTextEditor } from './rich-text-editor';
import {
  VariantBulkDialog,
  VariantGeneratorDialog,
  type BulkEditResult,
  type GeneratorData,
  type GeneratorResult,
} from './variant-dialogs';

/** A variant row as edited on screen: prices in shekels, and a key for tracking unsaved rows. */
interface VariantRow extends Omit<AdminVariant, 'price' | 'compareAtPrice'> {
  key: number;
  price: number | null;
  compareAtPrice: number | null;
}

interface Draft extends Omit<AdminProductInput, 'variants' | 'expectedUpdatedAt' | 'warrantyMonths'> {
  warrantyMonths: number | null;
}

let nextKey = 1;

/**
 * Create or edit a product with all its variants (Phase 2b, ADM-02, ADM-12). One save sends the
 * whole product; a save over someone else's newer change is refused by the API (approved proposal 4).
 */
@Component({
  selector: 'hga-product-form-page',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    RichTextEditor,
    LucideArrowRight,
    LucideChevronDown,
    LucideChevronUp,
    LucideImage,
    LucidePlus,
    LucideSparkles,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-form.page.html',
  styleUrl: './product-form.page.scss',
})
export class ProductFormPage implements OnInit {
  /** Route parameter: a product id, or "new". */
  readonly id = input.required<string>();

  private readonly api = inject(CatalogApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly editor = viewChild(RichTextEditor);

  protected readonly fulfillments = Object.entries(FULFILLMENT_LABEL) as [FulfillmentMode, string][];
  protected readonly structure = signal<CatalogStructure | null>(null);
  protected readonly product = signal<AdminProduct | null>(null);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** The last save was refused because someone else saved first. */
  protected readonly conflict = signal(false);
  /** Bumped on every edit so computed views (dirty, attributes) refresh with the plain-object draft. */
  protected readonly version = signal(0);

  protected readonly extraFields = [
    { key: 'seatHeightCm', label: 'גובה מושב (ס"מ)', step: 0.1 },
    { key: 'seatDepthCm', label: 'עומק מושב (ס"מ)', step: 0.1 },
    { key: 'chaiseWidthCm', label: 'רוחב שזלונג (ס"מ)', step: 0.1 },
    { key: 'chaiseDepthCm', label: 'עומק שזלונג (ס"מ)', step: 0.1 },
    { key: 'weightKg', label: 'משקל (ק"ג)', step: 0.1 },
    { key: 'productionDays', label: 'ימי ייצור', step: 1 },
  ] as const;

  protected draft: Draft = emptyDraft();
  protected rows: VariantRow[] = [];
  protected readonly selected = signal(new Set<number>());
  protected readonly expanded = signal(new Set<number>());
  /** Until the slug is typed by hand, it follows the model name and category (approved proposal 5). */
  private slugTouched = false;
  private savedJson = '';

  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly canEdit = computed(() => this.auth.me()?.permissions.includes('catalog.edit') ?? false);
  protected readonly isSuperAdmin = computed(() => this.auth.me()?.isSuperAdmin ?? false);
  protected readonly categories = computed(() => categoryOptions(this.structure()?.categories ?? []));

  /** The category's attributes, inherited from its parent (CLAUDE.md: filters are inherited). */
  private readonly categoryAttributeCodes = computed(() => {
    this.version();
    const all = this.structure()?.categories ?? [];
    const category = all.find((c) => c.id === this.draft.categoryId);
    const parent = all.find((c) => c.id === category?.parentId);
    return [...new Set([...(parent?.attributeCodes ?? []), ...(category?.attributeCodes ?? [])])];
  });

  /** Product-level attributes to show: the category's, plus any the product already has. */
  protected readonly productAttributes = computed(() => this.attributesOf('product'));
  protected readonly variantAttributes = computed(() => this.attributesOf('variant'));

  protected readonly dirty = computed(() => {
    this.version();
    return this.loaded() && JSON.stringify(this.payload()) !== this.savedJson;
  });

  protected readonly slugChangedWhileLive = computed(() => {
    this.version();
    const p = this.product();
    return !!p && p.active && p.slug !== this.draft.slug;
  });

  async ngOnInit() {
    try {
      const [structure, product] = await Promise.all([
        this.api.structure(),
        this.isNew() ? Promise.resolve(null) : this.api.product(Number(this.id())),
      ]);
      this.structure.set(structure);
      if (product) this.fill(product);
      else this.draft.roomIds = structure.rooms.filter((r) => r.active).map((r) => r.id);
      this.markSaved();
      this.loaded.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** Leaving with unsaved changes asks first (route guard and browser tab). */
  canLeave(): boolean {
    return !this.dirty() || confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  protected dimLabel(dim: string): string {
    return { widthCm: 'רוחב', depthCm: 'עומק', heightCm: 'גובה' }[dim] ?? dim;
  }

  protected touch() {
    this.version.update((v) => v + 1);
  }

  protected modelOrCategoryChanged() {
    if (!this.slugTouched && (this.isNew() || !this.product()?.active)) {
      const category = this.structure()?.categories.find((c) => c.id === this.draft.categoryId);
      this.draft.slug = suggestSlug(this.draft.modelName, category?.slug);
    }
    this.touch();
  }

  protected slugEdited() {
    this.slugTouched = true;
    this.touch();
  }

  protected toggleRoom(id: number, on: boolean) {
    this.draft.roomIds = on ? [...this.draft.roomIds, id] : this.draft.roomIds.filter((r) => r !== id);
    this.touch();
  }

  protected setAttribute(code: string, values: string[]) {
    this.draft.attributes = { ...this.draft.attributes, [code]: values };
    this.touch();
  }

  protected descriptionChanged(html: string) {
    this.draft.descriptionHe = html;
    this.touch();
  }

  // ---------- Variants ----------

  protected optionLabel(row: VariantRow): string {
    const attributes = this.structure()?.attributes ?? [];
    return Object.entries(row.options)
      .map(([code, value]) => attributes.find((a) => a.code === code)?.values.find((v) => v.code === value)?.labelHe)
      .filter(Boolean)
      .join(' · ');
  }

  protected setOption(row: VariantRow, code: string, value: string | null) {
    const options = { ...row.options };
    if (value) options[code] = value;
    else delete options[code];
    row.options = options;
    this.touch();
  }

  protected addRow() {
    const last = this.rows.at(-1);
    this.rows = [
      ...this.rows,
      last
        ? { ...structuredClone(last), id: undefined, key: nextKey++, sku: '' }
        : { ...emptyVariant(), key: nextKey++ },
    ];
    this.touch();
  }

  protected removeRow(row: VariantRow) {
    this.rows = this.rows.filter((r) => r !== row);
    this.selected.update((s) => new Set([...s].filter((k) => k !== row.key)));
    this.touch();
  }

  protected toggleExpanded(row: VariantRow) {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });
  }

  protected toggleSelected(row: VariantRow, on: boolean) {
    this.selected.update((s) => {
      const next = new Set(s);
      if (on) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
  }

  protected toggleAll(on: boolean) {
    this.selected.set(on ? new Set(this.rows.map((r) => r.key)) : new Set());
  }

  protected openGenerator() {
    this.dialog
      .open<VariantGeneratorDialog, GeneratorData, GeneratorResult>(VariantGeneratorDialog, {
        data: { attributes: this.variantAttributes() },
        width: '640px',
        maxWidth: '95vw',
      })
      .afterClosed()
      .subscribe((result) => result && this.generate(result));
  }

  private generate(result: GeneratorResult) {
    const axes = Object.entries(result.options).filter(([, values]) => values.length > 0);
    let combinations: Record<string, string>[] = [{}];
    for (const [code, values] of axes) {
      combinations = combinations.flatMap((c) => values.map((v) => ({ ...c, [code]: v })));
    }
    const exists = (options: Record<string, string>, widthCm: number) =>
      this.rows.some((r) => r.widthCm === widthCm && sameOptions(r.options, options));

    const added: VariantRow[] = [];
    for (const size of result.sizes) {
      for (const options of combinations) {
        if (exists(options, size.widthCm!)) continue;
        added.push({
          ...emptyVariant(),
          key: nextKey++,
          sku: [this.draft.modelName.trim().toUpperCase().replace(/\s+/g, '-'), size.widthCm, ...Object.values(options)]
            .filter((p) => p !== '' && p !== null)
            .join('-')
            .toUpperCase(),
          price: size.price,
          stock: result.stock,
          fulfillment: result.fulfillment,
          leadTimeDays: result.leadTimeDays,
          widthCm: size.widthCm!,
          depthCm: size.depthCm!,
          heightCm: size.heightCm!,
          options,
        });
      }
    }
    this.rows = [...this.rows, ...added];
    this.touch();
    this.snack.open(added.length ? `נוספו ${added.length} שורות` : 'כל הצירופים כבר קיימים', undefined, {
      duration: 3000,
    });
  }

  protected openBulkEdit() {
    const targets = this.selected().size ? this.rows.filter((r) => this.selected().has(r.key)) : this.rows;
    this.dialog
      .open<VariantBulkDialog, number, BulkEditResult>(VariantBulkDialog, {
        data: targets.length,
        width: '440px',
        maxWidth: '95vw',
      })
      .afterClosed()
      .subscribe((change) => {
        if (!change) return;
        for (const row of targets) {
          if (change.price !== undefined) row.price = change.price;
          if (change.pricePercent !== undefined && row.price !== null)
            row.price = Math.round(row.price * (1 + change.pricePercent / 100));
          if (change.compareAtPrice !== undefined) row.compareAtPrice = change.compareAtPrice || null;
          if (change.stock !== undefined) row.stock = change.stock;
          if (change.fulfillment !== undefined) row.fulfillment = change.fulfillment;
          if (change.leadTimeDays !== undefined) row.leadTimeDays = change.leadTimeDays;
          if (change.active !== undefined) row.active = change.active;
        }
        this.rows = [...this.rows];
        this.touch();
      });
  }

  // ---------- Save ----------

  async save() {
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(false);
    try {
      const input = this.payload();
      const saved = this.isNew()
        ? await this.api.createProduct(input)
        : await this.api.updateProduct(this.product()!.id, { ...input, expectedUpdatedAt: this.product()!.updatedAt });
      this.fill(saved);
      this.markSaved();
      this.snack.open(saved.active ? 'נשמר. השינויים כבר באתר.' : 'נשמר. המוצר מוסתר מהאתר.', undefined, {
        duration: 4000,
      });
      if (this.isNew()) await this.router.navigate(['/catalog/products', saved.id], { replaceUrl: true });
    } catch (e) {
      this.error.set(errorMessage(e));
      this.conflict.set(e instanceof HttpErrorResponse && e.error?.code === 'conflict');
    } finally {
      this.busy.set(false);
    }
  }

  /** After a conflict: load the newer version, dropping this screen's changes. */
  async reload() {
    if (this.dirty() && !confirm('השינויים שלא נשמרו במסך הזה יימחקו. לטעון את הגרסה העדכנית?')) return;
    try {
      this.fill(await this.api.product(this.product()!.id));
      this.markSaved();
      this.error.set('');
      this.conflict.set(false);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove() {
    const p = this.product();
    if (!p || !confirm(`למחוק את ${p.modelName} לצמיתות? אי אפשר לבטל. כדי רק להוריד מהאתר, כבו "מוצג באתר".`)) return;
    try {
      await this.api.deleteProduct(p.id);
      this.savedJson = JSON.stringify(this.payload());
      this.loaded.set(false);
      this.snack.open('המוצר נמחק', undefined, { duration: 3000 });
      await this.router.navigateByUrl('/catalog/products');
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private payload(): AdminProductInput {
    return {
      ...this.draft,
      variants: this.rows.map(({ key: _key, price, compareAtPrice, ...v }) => ({
        ...v,
        price: toAgorot(price) ?? 0,
        compareAtPrice: toAgorot(compareAtPrice),
        productionDays: v.productionDays ?? null,
        expectedAt: v.expectedAt || null,
      })),
    };
  }

  private fill(p: AdminProduct) {
    this.product.set(p);
    const { id: _id, createdAt: _c, updatedAt: _u, variants, ...draft } = p;
    this.draft = structuredClone(draft);
    this.rows = variants.map((v) => ({
      ...v,
      key: nextKey++,
      price: toShekels(v.price),
      compareAtPrice: toShekels(v.compareAtPrice),
    }));
    this.selected.set(new Set());
    this.slugTouched = true;
    this.editor()?.setContent(p.descriptionHe);
    this.touch();
  }

  private markSaved() {
    this.savedJson = JSON.stringify(this.payload());
    this.touch();
  }

  private attributesOf(scope: 'product' | 'variant'): AdminAttribute[] {
    this.version();
    const codes = new Set(this.categoryAttributeCodes());
    if (scope === 'product') Object.keys(this.draft.attributes).forEach((c) => codes.add(c));
    else this.rows.forEach((r) => Object.keys(r.options).forEach((c) => codes.add(c)));
    return (this.structure()?.attributes ?? []).filter((a) => a.scope === scope && codes.has(a.code));
  }
}

function emptyDraft(): Draft {
  return {
    slug: '',
    modelName: '',
    nameHe: '',
    descriptionHe: '',
    categoryId: 0,
    roomIds: [],
    attributes: {},
    countryOfOrigin: null,
    warrantyMonths: 12,
    careHe: null,
    requiresAssembly: false,
    active: false,
    sortOrder: 0,
  };
}

function emptyVariant(): Omit<VariantRow, 'key'> {
  return {
    sku: '',
    price: null,
    compareAtPrice: null,
    stock: 0,
    fulfillment: 'in_stock',
    leadTimeDays: 14,
    productionDays: null,
    expectedAt: null,
    active: true,
    widthCm: 0,
    depthCm: 0,
    heightCm: 0,
    weightKg: null,
    seatHeightCm: null,
    seatDepthCm: null,
    chaiseWidthCm: null,
    chaiseDepthCm: null,
    options: {},
  };
}

function sameOptions(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}
