import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { ErrorStateMatcher } from '@angular/material/core';
import { LucidePlus, LucideX } from '@lucide/angular';
import type { AdminShippingConfig, AdminShippingZone, LocalityOption } from '@hg/models';
import { errorMessage } from '../core/errors';
import { ShippingApi } from '../core/shipping.api';
import { LocalityPicker } from './locality-picker';
import {
  rateRows,
  ratesInput,
  settingsForm,
  zoneDraft,
  zoneInput,
  type FormErrors,
  type RateRow,
  type SettingsForm,
  type ZoneDraft,
} from './shipping-form';

/**
 * Shipping price list and remote zones (spec §4.4, ADM-07, permission shipping.manage): delivery and assembly
 * per top-level category plus the default row, the multi-item percent, the floor surcharge, and zones with
 * their localities. Prices are typed in shekels and saved in agorot.
 */
@Component({
  selector: 'hga-shipping-page',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, LucidePlus, LucideX, LocalityPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shipping.page.html',
  styleUrl: './shipping.page.scss',
})
export class ShippingPage implements OnInit {
  private readonly api = inject(ShippingApi);
  private readonly snack = inject(MatSnackBar);
  private nextKey = 1;

  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly rows = signal<RateRow[]>([]);
  protected readonly settings = signal<SettingsForm>({
    additionalItemPercent: '',
    floorSurcharge: '',
    floorSurchargeFrom: '',
  });
  /** False until the default row was saved once: it then shows 0 / 0. */
  protected readonly defaultRateSet = signal(true);
  protected readonly rateErrors = signal<FormErrors>({});
  protected readonly ratesProblem = signal('');
  protected readonly savingRates = signal(false);

  protected readonly zones = signal<ZoneDraft[]>([]);
  /** Field errors per zone, as "<key>.name" / "<key>.surcharge". */
  protected readonly zoneErrors = signal<FormErrors>({});
  /** A save or delete the server refused, per zone key. */
  protected readonly zoneProblems = signal<Record<number, string>>({});
  protected readonly busyZone = signal<number | null>(null);

  /** What the server has for each zone (by key): a locality picked but not saved yet is in no zone there. */
  private readonly saved = signal(new Map<number, { name: string; localityIds: number[] }>());
  /** The saved zone of every locality, to tell which ones another zone already has. */
  private readonly savedZoneOf = computed(() => {
    const map = new Map<number, { key: number; name: string }>();
    for (const [key, z] of this.saved()) for (const id of z.localityIds) map.set(id, { key, name: z.name });
    return map;
  });
  /** Rates and settings as last loaded or saved; the screen is dirty when they differ. */
  private readonly ratesBaseline = signal('');
  /** Each zone (by key) as last loaded or saved; a zone with no entry is new and unsaved. */
  private readonly zoneBaseline = signal(new Map<number, string>());
  protected readonly dirty = computed(
    () =>
      this.loaded() &&
      (ratesSnapshot(this.rows(), this.settings()) !== this.ratesBaseline() ||
        this.zones().some((z) => this.zoneBaseline().get(z.key) !== zoneSnapshot(z))),
  );
  private readonly matchers = new Map<string, ErrorStateMatcher>();

  ngOnInit() {
    void this.load();
  }

  /** Leaving with unsaved changes asks first (route guard and browser tab). */
  canLeave(): boolean {
    return !this.dirty() || confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  /** Marks a field invalid while the last check found a problem with it (the fields use ngModel, no form). */
  private matcher(id: string, invalid: () => boolean): ErrorStateMatcher {
    let m = this.matchers.get(id);
    if (!m) {
      m = { isErrorState: invalid };
      this.matchers.set(id, m);
    }
    return m;
  }

  /** "rates.<row>.delivery", "additionalItemPercent"... */
  protected rateMatcher(field: string) {
    return this.matcher(`rates:${field}`, () => !!this.rateErrors()[field]);
  }

  /** "<zone key>.name" or "<zone key>.surcharge". */
  protected zoneMatcher(field: string) {
    return this.matcher(`zone:${field}`, () => !!this.zoneErrors()[field]);
  }

  protected rateId(row: RateRow, field: 'delivery' | 'assembly') {
    return `rate-${row.categoryId ?? 'default'}-${field}`;
  }

  protected setRate(index: number, field: 'delivery' | 'assembly', value: string) {
    this.rows.update((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  protected setSetting(field: keyof SettingsForm, value: string) {
    this.settings.update((s) => ({ ...s, [field]: value }));
  }

  async saveRates() {
    const { input, errors } = ratesInput(this.rows(), this.settings());
    this.rateErrors.set(errors);
    this.ratesProblem.set('');
    if (!input) return;
    this.savingRates.set(true);
    try {
      const saved = await this.api.saveRates(input);
      this.rows.set(rateRows(saved));
      this.defaultRateSet.set(saved.defaultRateSet);
      this.settings.set(settingsForm(saved.settings));
      this.ratesBaseline.set(ratesSnapshot(this.rows(), this.settings()));
      this.snack.open('המחירון נשמר', undefined, { duration: 2500 });
    } catch (e) {
      this.ratesProblem.set(errorMessage(e));
    } finally {
      this.savingRates.set(false);
    }
  }

  // ---------- Zones ----------

  protected addZone() {
    this.zones.update((zones) => [
      ...zones,
      { key: this.nextKey++, id: null, name: '', surcharge: '', localities: [] },
    ]);
  }

  protected setZone(key: number, patch: Partial<Pick<ZoneDraft, 'name' | 'surcharge'>>) {
    this.updateZone(key, (z) => ({ ...z, ...patch }));
  }

  protected addLocality(key: number, locality: LocalityOption) {
    this.updateZone(key, (z) =>
      z.localities.some((l) => l.id === locality.id) ? z : { ...z, localities: [...z.localities, locality] },
    );
  }

  protected removeLocality(key: number, id: number) {
    this.updateZone(key, (z) => ({ ...z, localities: z.localities.filter((l) => l.id !== id) }));
  }

  protected localityIds(zone: ZoneDraft): number[] {
    return zone.localities.map((l) => l.id);
  }

  /** The other saved zone a locality is in, for the picker of zone `key`. */
  protected otherZoneFor(key: number) {
    return (localityId: number) => {
      const owner = this.savedZoneOf().get(localityId);
      return owner && owner.key !== key ? owner.name : undefined;
    };
  }

  async saveZone(zone: ZoneDraft) {
    const { input, errors } = zoneInput(zone);
    this.zoneErrors.update((all) => ({
      ...withoutZone(all, zone.key),
      ...Object.fromEntries(Object.entries(errors).map(([field, text]) => [`${zone.key}.${field}`, text])),
    }));
    this.setProblem(zone.key, '');
    if (!input) return;
    this.busyZone.set(zone.key);
    try {
      const saved = zone.id === null ? await this.api.createZone(input) : await this.api.updateZone(zone.id, input);
      const draft = zoneDraft(saved, zone.key);
      this.updateZone(zone.key, () => draft);
      this.zoneBaseline.update((map) => new Map(map).set(zone.key, zoneSnapshot(draft)));
      this.remember(zone.key, saved);
      this.snack.open('האזור נשמר', undefined, { duration: 2500 });
    } catch (e) {
      this.setProblem(zone.key, errorMessage(e));
    } finally {
      this.busyZone.set(null);
    }
  }

  async deleteZone(zone: ZoneDraft) {
    if (zone.id !== null && !confirm(`למחוק את האזור "${zone.name}"?`)) return;
    this.busyZone.set(zone.key);
    try {
      if (zone.id !== null) await this.api.deleteZone(zone.id);
      this.zones.update((zones) => zones.filter((z) => z.key !== zone.key));
      this.zoneErrors.update((all) => withoutZone(all, zone.key));
      this.saved.update((map) => {
        const next = new Map(map);
        next.delete(zone.key);
        return next;
      });
      this.zoneBaseline.update((map) => {
        const next = new Map(map);
        next.delete(zone.key);
        return next;
      });
      if (zone.id !== null) this.snack.open('האזור נמחק', undefined, { duration: 2500 });
    } catch (e) {
      this.setProblem(zone.key, errorMessage(e));
    } finally {
      this.busyZone.set(null);
    }
  }

  private updateZone(key: number, change: (z: ZoneDraft) => ZoneDraft) {
    this.zones.update((zones) => zones.map((z) => (z.key === key ? change(z) : z)));
  }

  private remember(key: number, zone: AdminShippingZone) {
    this.saved.update((map) =>
      new Map(map).set(key, { name: zone.name, localityIds: zone.localities.map((l) => l.id) }),
    );
  }

  private setProblem(key: number, text: string) {
    this.zoneProblems.update((all) => ({ ...all, [key]: text }));
  }

  private async load() {
    try {
      const config: AdminShippingConfig = await this.api.config();
      this.rows.set(rateRows(config));
      this.defaultRateSet.set(config.defaultRateSet);
      this.settings.set(settingsForm(config.settings));
      const drafts = config.zones.map((z) => zoneDraft(z, this.nextKey++));
      this.zones.set(drafts);
      this.ratesBaseline.set(ratesSnapshot(this.rows(), this.settings()));
      this.zoneBaseline.set(new Map(drafts.map((d) => [d.key, zoneSnapshot(d)])));
      config.zones.forEach((z, i) => this.remember(drafts[i].key, z));
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}

const ratesSnapshot = (rows: RateRow[], settings: SettingsForm) => JSON.stringify({ rows, settings });

const zoneSnapshot = (z: ZoneDraft) =>
  JSON.stringify({ name: z.name, surcharge: z.surcharge, localities: z.localities.map((l) => l.id).sort() });

function withoutZone(errors: FormErrors, key: number): FormErrors {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => !k.startsWith(`${key}.`)));
}
