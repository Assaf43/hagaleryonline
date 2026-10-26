import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { catchError, of } from 'rxjs';
import type { HealthStatus } from '@hg/models';
import { ThemeToggle } from '@hg/ui';

@Component({
  selector: 'hga-root',
  imports: [RouterOutlet, MatToolbarModule, MatButtonModule, ThemeToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  /** Phase 0 smoke check of the API and the database. */
  private readonly health = toSignal(
    inject(HttpClient)
      .get<HealthStatus>('/api/health')
      .pipe(catchError(() => of('unreachable' as const))),
  );

  protected readonly apiOk = computed(() => {
    const h = this.health();
    return h === undefined ? null : h !== 'unreachable' && h.status === 'ok';
  });
}
