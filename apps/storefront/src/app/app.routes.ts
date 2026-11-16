import { Routes } from '@angular/router';
import { accountGuard } from './account/account.guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home.page').then((m) => m.HomePage) },
  {
    path: 'category/:slug',
    loadComponent: () => import('./catalog/listing.page').then((m) => m.ListingPage),
    data: { kind: 'category' },
  },
  {
    path: 'room/:slug',
    loadComponent: () => import('./catalog/listing.page').then((m) => m.ListingPage),
    data: { kind: 'room' },
  },
  {
    path: 'search',
    loadComponent: () => import('./catalog/listing.page').then((m) => m.ListingPage),
    data: { kind: 'search' },
  },
  { path: 'product/:slug', loadComponent: () => import('./catalog/product.page').then((m) => m.ProductPage) },
  { path: 'cart', loadComponent: () => import('./cart/cart.page').then((m) => m.CartPage) },
  { path: 'checkout', loadComponent: () => import('./checkout/checkout.page').then((m) => m.CheckoutPage) },
  { path: 'order/:number', loadComponent: () => import('./order/order.page').then((m) => m.OrderPage) },
  // "My order status" (SHP-05): noindex, not in the sitemap.
  {
    path: 'order-status',
    loadComponent: () => import('./order-status/order-status.page').then((m) => m.OrderStatusPage),
  },
  {
    path: 'pay/sandbox/:transactionId',
    loadComponent: () => import('./pay/sandbox-pay.page').then((m) => m.SandboxPayPage),
  },
  { path: 'pay/done', loadComponent: () => import('./pay/pay-done.page').then((m) => m.PayDonePage) },
  { path: 'delivery/:token', loadComponent: () => import('./delivery/delivery.page').then((m) => m.DeliveryPage) },
  // Customer accounts (Phase 5c): all noindex, read in the browser after the session is known.
  { path: 'account', loadComponent: () => import('./account/sign-in.page').then((m) => m.SignInPage) },
  { path: 'account/sign-up', loadComponent: () => import('./account/sign-up.page').then((m) => m.SignUpPage) },
  {
    path: 'account/orders',
    canActivate: [accountGuard],
    loadComponent: () => import('./account/orders.page').then((m) => m.OrdersPage),
  },
  {
    path: 'account/orders/:number',
    canActivate: [accountGuard],
    loadComponent: () => import('./account/order-detail.page').then((m) => m.OrderDetailPage),
  },
  {
    path: 'account/details',
    canActivate: [accountGuard],
    loadComponent: () => import('./account/details.page').then((m) => m.DetailsPage),
  },
  {
    path: 'account/addresses',
    canActivate: [accountGuard],
    loadComponent: () => import('./account/addresses.page').then((m) => m.AddressesPage),
  },
  {
    path: 'account/consent',
    canActivate: [accountGuard],
    loadComponent: () => import('./account/consent.page').then((m) => m.ConsentPage),
  },
  // Returns, damaged products and contact (Phase 5d, SRV-02, SRV-03, SRV-05): noindex, not in the sitemap.
  { path: 'returns', loadComponent: () => import('./support/return.page').then((m) => m.ReturnPage) },
  { path: 'returns/damaged', loadComponent: () => import('./support/damaged.page').then((m) => m.DamagedPage) },
  { path: 'contact', loadComponent: () => import('./support/contact.page').then((m) => m.ContactPage) },
  // Newsletter (Phase 7, MKT-01, CLB-02): noindex, the token comes in `?t=` and is used in the browser only.
  {
    path: 'newsletter/confirm',
    loadComponent: () => import('./newsletter/confirm.page').then((m) => m.NewsletterConfirmPage),
  },
  {
    path: 'newsletter/unsubscribe',
    loadComponent: () => import('./newsletter/unsubscribe.page').then((m) => m.NewsletterUnsubscribePage),
  },
  { path: 'terms', loadComponent: () => import('./info/terms.page').then((m) => m.TermsPage) },
  { path: 'favorites', loadComponent: () => import('./favorites/favorites.page').then((m) => m.FavoritesPage) },
  { path: 'sizing-guide', loadComponent: () => import('./guide/sizing-guide.page').then((m) => m.SizingGuidePage) },
  { path: '**', loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage) },
];
