import { Injectable } from '@nestjs/common';
import type { LocalityOption } from '@hg/models';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeLocality } from './localities.js';

const LIMIT = 10;
const CACHE_MS = 10 * 60_000;

interface Entry extends LocalityOption {
  key: string;
}

@Injectable()
export class LocalitiesService {
  private cache: { at: number; entries: Entry[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Prefix matches first, then contains matches, each alphabetical; max 10. */
  async search(q: string): Promise<LocalityOption[]> {
    const needle = normalizeLocality(q);
    if (!needle) return [];
    const entries = await this.load();
    const starts: Entry[] = [];
    const contains: Entry[] = [];
    for (const e of entries) {
      if (e.key.startsWith(needle)) starts.push(e);
      else if (e.key.includes(needle)) contains.push(e);
    }
    return [...starts, ...contains].slice(0, LIMIT).map(({ id, nameHe }) => ({ id, nameHe }));
  }

  private async load(): Promise<Entry[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.entries;
    const rows = await this.prisma.locality.findMany();
    const entries = rows
      .map((r) => ({ id: r.id, nameHe: r.nameHe, key: normalizeLocality(r.nameHe) }))
      .sort((a, b) => a.key.localeCompare(b.key, 'he'));
    this.cache = { at: Date.now(), entries };
    return entries;
  }
}
