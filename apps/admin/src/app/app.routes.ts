import { Routes } from '@angular/router';
import { hasPermission, signedIn, signedOut, superAdminOnly } from './core/guards';

export const routes: Routes = [
  {
    path: 'login',
    canMatch: [signedOut],
    loadComponent: () => import('./login/login.page').then((m) => m.LoginPage),
    title: 'כניסה',
  },
  {
    path: 'login/setup-2fa',
    loadComponent: () => import('./login/setup-2fa.page').then((m) => m.Setup2faPage),
    title: 'הגדרת אימות דו-שלבי',
  },
  {
    path: 'login/verify',
    loadComponent: () => import('./login/verify-2fa.page').then((m) => m.Verify2faPage),
    title: 'אימות',
  },
  { path: 'invite/:token', loadComponent: () => import('./login/link.page').then((m) => m.LinkPage), title: 'הצטרפות' },
  {
    path: 'reset-password/:token',
    loadComponent: () => import('./login/link.page').then((m) => m.LinkPage),
    title: 'סיסמה חדשה',
  },
  {
    path: '',
    canMatch: [signedIn],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', loadComponent: () => import('./home/home.page').then((m) => m.HomePage), title: 'לוח בקרה' },
      {
        path: 'users',
        canMatch: [superAdminOnly],
        loadComponent: () => import('./users/users.page').then((m) => m.UsersPage),
        title: 'משתמשים והרשאות',
      },
      {
        path: 'audit',
        canMatch: [hasPermission('audit.view')],
        loadComponent: () => import('./audit/audit.page').then((m) => m.AuditPageComponent),
        title: 'יומן שינויים',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
