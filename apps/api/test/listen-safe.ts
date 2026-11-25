import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The Fetch standard's "bad ports" (https://fetch.spec.whatwg.org/#port-blocking), which Node's built-in fetch
 * (undici) refuses with "bad port". undici does not export the list; this copy matches its
 * `lib/web/fetch/constants.js` `badPorts`.
 */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const MAX_TRIES = 10;

/**
 * Listens on an ephemeral 127.0.0.1 port that fetch may call, and returns its base URL. Where the OS's dynamic range
 * starts low (this Windows machine: 1024), port 0 can draw a blocked port; then the server is closed and listens again.
 */
export async function listenSafe(app: NestExpressApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  for (let tries = 1; ; tries++) {
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BAD_PORTS.has(port)) return `http://127.0.0.1:${port}`;
    if (tries >= MAX_TRIES) throw new Error(`listenSafe: drew a fetch-blocked port ${MAX_TRIES} times`);
    await new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
}
