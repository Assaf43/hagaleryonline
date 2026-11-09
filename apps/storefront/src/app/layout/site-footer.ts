import { BRAND } from '@hg/models';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MenuData } from './menu-data';

/**
 * Footer: rooms and furniture types. Service and policy pages (shipping, returns, terms, privacy,
 * accessibility statement) are added with the content pages in Phase 8.
 */
@Component({
  selector: 'hg-site-footer',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer class="footer">
      <div class="container">
        <div class="cols">
          <div>
            <p class="logo">{{ brand }}</p>
            <p class="small muted">רהיטים לבית, עם מידות מלאות לכל דגם ומשלוח עד הבית.</p>
          </div>
          @if (menu.rooms().length) {
            <nav aria-labelledby="footer-rooms">
              <h2 id="footer-rooms">לפי חדרים</h2>
              <ul>
                @for (r of menu.rooms(); track r.slug) {
                  <li>
                    <a [routerLink]="['/room', r.slug]">{{ r.nameHe }}</a>
                  </li>
                }
              </ul>
            </nav>
          }
          @if (menu.categories().length) {
            <nav aria-labelledby="footer-types">
              <h2 id="footer-types">לפי סוג רהיט</h2>
              <ul class="types">
                @for (c of menu.categories(); track c.slug) {
                  <li>
                    <a [routerLink]="['/category', c.slug]">{{ c.nameHe }}</a>
                  </li>
                }
              </ul>
            </nav>
          }
        </div>
        <p class="bottom">© {{ year }} {{ brand }}</p>
      </div>
    </footer>
  `,
  styles: `
    .footer {
      background: var(--color-surface);
      border-block-start: var(--border-width) solid var(--color-border);
      margin-block-start: var(--space-8);
      padding-block: var(--space-7) var(--space-6);
    }

    .cols {
      display: grid;
      gap: var(--space-6);
    }

    @media (width >= 768px) {
      .cols {
        grid-template-columns: 2fr 1fr 2fr;
      }
    }

    .logo {
      font-family: var(--font-heading);
      font-size: var(--font-h2);
      margin-block-end: var(--space-3);
    }

    h2 {
      font-family: var(--font-sans);
      font-size: var(--font-body);
      font-weight: 600;
      margin-block-end: var(--space-3);
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-2);
      font-size: var(--font-small);
    }

    .types {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    a {
      color: var(--color-text-secondary);
      text-decoration: none;
      display: inline-block;
      padding-block: var(--space-1);
    }

    a:hover {
      color: var(--color-text);
      text-decoration: underline;
    }

    .bottom {
      margin-block-start: var(--space-6);
      padding-block-start: var(--space-4);
      border-block-start: var(--border-width) solid var(--color-border);
      font-size: var(--font-small);
      color: var(--color-text-secondary);
    }
  `,
})
export class SiteFooter {
  protected readonly brand = BRAND.name;
  protected readonly menu = inject(MenuData);
  protected readonly year = new Date().getFullYear();
}
