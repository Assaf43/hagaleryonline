import { Routes } from '@angular/router';

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
  { path: 'terms', loadComponent: () => import('./info/terms.page').then((m) => m.TermsPage) },
  { path: 'favorites', loadComponent: () => import('./favorites/favorites.page').then((m) => m.FavoritesPage) },
  { path: 'sizing-guide', loadComponent: () => import('./guide/sizing-guide.page').then((m) => m.SizingGuidePage) },
  { path: '**', loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage) },
];
