import { RenderMode, ServerRoute } from '@angular/ssr';

// Server-render every page (NFR-03): catalog data changes often, and the saved theme
// comes from the request cookie.
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
