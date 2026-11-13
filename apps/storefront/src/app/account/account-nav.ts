import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { CustomerStore } from './customer.store';

/** The links between the account pages, and sign-out (which goes back to the home page). */
@Component({
  selector: 'hg-account-nav',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="account-nav" aria-label="החשבון שלי">
      <a routerLink="/account/orders" routerLinkActive="active" ariaCurrentWhenActive="page">ההזמנות שלי</a>
      <a routerLink="/account/details" routerLinkActive="active" ariaCurrentWhenActive="page">פרטים אישיים</a>
      <a routerLink="/account/addresses" routerLinkActive="active" ariaCurrentWhenActive="page">כתובות</a>
      <a routerLink="/account/consent" routerLinkActive="active" ariaCurrentWhenActive="page">דיוור ועדכונים</a>
      <button type="button" class="sign-out" (click)="signOut()">התנתקות</button>
    </nav>
  `,
  styleUrl: './account.scss',
})
export class AccountNav {
  private readonly store = inject(CustomerStore);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    await this.store.signOut();
    void this.router.navigateByUrl('/');
  }
}
