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
  {
    path: 'pay/sandbox/:transactionId',
    loadComponent: () => import('./pay/sandbox-pay.page').then((m) => m.SandboxPayPage),
  },
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
  { path: 'terms', loadComponent: () => import('./info/terms.page').then((m) => m.TermsPage) },
  { path: 'favorites', loadComponent: () => import('./favorites/favorites.page').then((m) => m.FavoritesPage) },
  { path: 'sizing-guide', loadComponent: () => import('./guide/sizing-guide.page').then((m) => m.SizingGuidePage) },
  { path: '**', loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage) },
];
