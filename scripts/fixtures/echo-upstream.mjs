// Test double for `api:3000` and `web:4000` in scripts/caddy-proxy.spec.mjs: answers every request with the
// headers it received as JSON, plus the port, method, path and the number of body bytes it read. It reads the whole
// body first, so a request Caddy cuts off at its body limit never gets a 200 from here.
import { createServer } from 'node:http';

const ports = (process.env.ECHO_PORTS ?? '3000,4000').split(',').map(Number);

for (const port of ports) {
  createServer((req, res) => {
    let bodyBytes = 0;
    req.on('data', (chunk) => (bodyBytes += chunk.length));
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const body = JSON.stringify({ port, method: req.method, url: req.url, headers: req.headers, bodyBytes });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    });
  }).listen(port, '0.0.0.0', () => console.log(`echo listening on ${port}`));
}
