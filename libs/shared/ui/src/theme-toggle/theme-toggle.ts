import { ChangeDetectionStrategy, Component, DOCUMENT, inject } from '@angular/core';
import { LucideMoon, LucideSun } from '@lucide/angular';
import { THEME_ATTRIBUTE, effectiveTheme, saveTheme, type Theme } from '@hg/theme';

/**
 * Light / dark switch (GEN-05). Both icons are rendered and CSS shows the right one,
 * so the server render never disagrees with the browser before the user has chosen.
 */
@Component({
  selector: 'hg-theme-toggle',
  imports: [LucideMoon, LucideSun],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="theme-toggle" aria-label="מעבר בין מצב בהיר למצב כהה" (click)="toggle()">
      <svg lucideMoon class="icon-moon"></svg>
      <svg lucideSun class="icon-sun"></svg>
    </button>
  `,
  styleUrl: './theme-toggle.scss',
})
export class ThemeToggle {
  private readonly document = inject(DOCUMENT);

  toggle(): void {
    const saved = this.document.documentElement.getAttribute(THEME_ATTRIBUTE) as Theme | null;
    const prefersDark = this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches ?? false;
    saveTheme(this.document, effectiveTheme(saved, prefersDark) === 'dark' ? 'light' : 'dark');
  }
}
