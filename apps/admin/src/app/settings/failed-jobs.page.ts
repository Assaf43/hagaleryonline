import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { OUTBOX_JOB_LABELS_HE, type AdminFailedJob } from '@hg/models';
import { errorMessage } from '../core/errors';
import { JobsApi } from '../core/jobs.api';

/**
 * "משימות שנכשלו" (spec §5.1, permission orders.manage): outbox jobs (e-mails, SMS, invoices, refunds) that failed
 * after all their retries, the latest first, with "נסה שוב" (the job runs again from its first attempt). On phones
 * each job is a card; from desktop width the cells line up.
 */
@Component({
  selector: 'hga-failed-jobs-page',
  imports: [DatePipe, RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './failed-jobs.page.html',
  styleUrl: './failed-jobs.page.scss',
})
export class FailedJobsPage {
  private readonly api = inject(JobsApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminFailedJob[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly labels = OUTBOX_JOB_LABELS_HE;

  constructor() {
    void this.load();
  }

  protected reload() {
    void this.load();
  }

  async retry(job: AdminFailedJob) {
    this.busy.set(job.id);
    this.error.set('');
    try {
      await this.api.retry(job.id);
      this.items.update((list) => list?.filter((j) => j.id !== job.id) ?? null);
      this.snack.open('המשימה תרוץ שוב בדקות הקרובות', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }

  private async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.failed());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
