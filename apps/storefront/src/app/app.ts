import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterOutlet } from '@angular/router';
import type { HealthStatus } from '@hg/models';
import { ThemeToggle } from '@hg/ui';

@Component({
  selector: 'hg-root',
  imports: [RouterOutlet, ThemeToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly http = inject(HttpClient);

  /** Phase 0 smoke check: null until the browser has asked the API. */
  private readonly apiStatus = signal<HealthStatus | 'unreachable' | null>(null);

  protected readonly apiCheck = computed(() => {
    const s = this.apiStatus();
    if (s === null) return { text: 'בודק חיבור לשרת…', tone: 'pending' };
    if (s === 'unreachable') return { text: 'השרת לא זמין', tone: 'down' };
    return s.status === 'ok'
      ? { text: 'השרת ומסד הנתונים פעילים', tone: 'up' }
      : { text: 'מסד הנתונים לא זמין', tone: 'down' };
  });

  constructor() {
    afterNextRender(() => {
      this.http.get<HealthStatus>('/api/health').subscribe({
        next: (status) => this.apiStatus.set(status),
        error: () => this.apiStatus.set('unreachable'),
      });
    });
  }
}
