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
  { path: '**', loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage) },
];
