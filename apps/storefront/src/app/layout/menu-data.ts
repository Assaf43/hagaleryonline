import { Injectable, inject, signal } from '@angular/core';
import type { CategoryNode, RoomMenuItem } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';

/**
 * Rooms and furniture types for the menus, breadcrumbs and category pages. Only rooms and
 * categories with products on the site are returned by the API (decision 44), so a room added in
 * the admin appears here by itself.
 */
@Injectable({ providedIn: 'root' })
export class MenuData {
  private readonly api = inject(CatalogApi);
  private loading: Promise<void> | null = null;

  readonly rooms = signal<RoomMenuItem[]>([]);
  readonly categories = signal<CategoryNode[]>([]);

  /** Loads once per app (the server render passes the result to the browser). */
  load(): Promise<void> {
    this.loading ??= Promise.all([this.api.rooms(), this.api.categories()])
      .then(([rooms, categories]) => {
        this.rooms.set(rooms);
        this.categories.set(categories);
      })
      .catch(() => {
        // The page still works without menus; try again on the next navigation.
        this.loading = null;
      });
    return this.loading;
  }

  /** The category and its ancestors, root first; empty when unknown. */
  pathTo(slug: string): CategoryNode[] {
    const walk = (nodes: CategoryNode[], trail: CategoryNode[]): CategoryNode[] => {
      for (const node of nodes) {
        if (node.slug === slug) return [...trail, node];
        const found = walk(node.children, [...trail, node]);
        if (found.length) return found;
      }
      return [];
    };
    return walk(this.categories(), []);
  }
}
