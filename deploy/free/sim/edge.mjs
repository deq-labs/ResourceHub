// Local stand-in for Vercel. It applies the `routes` in apps/web/vercel.json (the real file, so
// the simulation tests it): response headers, `continue`, the external /api rewrite with its
// request-header transforms, `handle: filesystem` and the SPA fallback. External destinations
// go to API_ORIGIN instead of the Render URL. Not a general Vercel emulator: it supports
// exactly the features vercel.json uses.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';

const config = JSON.parse(readFileSync('/vercel.json', 'utf8'));
const STATIC = '/web';
const API = new URL(process.env.API_ORIGIN ?? 'http://app:10000');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function staticFile(pathname) {
  const file = normalize(join(STATIC, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function sendFile(res, file, headers) {
  res.writeHead(200, {
    ...headers,
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
}

function proxy(req, res, path, route, headers) {
  const out = {
    ...req.headers,
    host: API.host,
    'x-forwarded-host': req.headers.host,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': req.socket.remoteAddress,
  };
  for (const t of route.transforms ?? []) {
    if (t.type === 'request.headers' && t.op === 'set') {
      out[t.target.key] = t.args.startsWith('$') ? (process.env[t.args.slice(1)] ?? '') : t.args;
    }
  }
  const up = http.request(
    { host: API.hostname, port: API.port, path, method: req.method, headers: out },
    (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...headers });
      r.pipe(res);
    },
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`edge: API unreachable (${e.message}). Is the app container up?`);
  });
  req.pipe(up);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://edge');
    let headers = {};
    for (const route of config.routes) {
      if (route.handle === 'filesystem') {
        const file = staticFile(url.pathname);
        if (file) return sendFile(res, file, headers);
        continue;
      }
      const m = new RegExp(`^${route.src}$`).exec(url.pathname);
      if (!m) continue;
      headers = { ...headers, ...(route.headers ?? {}) };
      if (route.continue) continue;
      const dest = route.dest.replace(/\$(\d+)/g, (_, i) => m[Number(i)] ?? '');
      if (/^https?:\/\//.test(dest)) {
        const target = new URL(dest);
        return proxy(req, res, target.pathname + url.search, route, headers);
      }
      const file = staticFile(dest);
      if (file) return sendFile(res, file, headers);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('edge: not found (did you run `pnpm build` so apps/web/dist exists?)');
  })
  .listen(8080, () => console.log('edge (Vercel stand-in) on :8080'));
