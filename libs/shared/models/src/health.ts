/** Response of GET /api/health. */
export interface HealthStatus {
  status: 'ok' | 'error';
  db: 'up' | 'down';
}
