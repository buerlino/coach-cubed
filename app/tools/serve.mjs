// Serves the assembled app (app/dist/) for development:
//
//   node app/tools/serve.mjs [--port N] [--dir DIR]
//
// Like the WebView, and unlike a host that sets COOP/COEP, it sends no
// cross-origin-isolation headers. Node only, no dependencies. Port 0 picks a
// free port; the address is printed.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function parseArgs(argv) {
  const opts = { port: 8080, dir: resolve(HERE, '..', 'dist') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && i + 1 < argv.length) opts.port = Number(argv[++i]);
    else if (argv[i] === '--dir' && i + 1 < argv.length) opts.dir = resolve(argv[++i]);
    else throw new Error(`usage: serve.mjs [--port N] [--dir DIR] (got ${argv[i]})`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port wants a number from 0 to 65535');
  return opts;
}

export function createApp(dir) {
  return createServer((req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { path = null; }
    const file = path && !path.includes('\0') ? resolve(join(dir, path)) : null;
    let target = null;
    if (file && (file === dir || file.startsWith(dir + sep))) {
      try {
        const st = statSync(file);
        target = st.isDirectory() ? join(file, 'index.html') : file;
        if (st.isDirectory()) statSync(target);
      } catch { target = null; }
    }
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      console.log(`404 ${req.url}`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(target).pipe(res);
    console.log(`200 ${req.url}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { port, dir } = parseArgs(process.argv.slice(2));
    const server = createApp(dir);
    server.listen(port, '127.0.0.1', () => console.log(`serving ${dir} at http://127.0.0.1:${server.address().port}/`));
  } catch (e) {
    console.error(`serve: ${e.message}`);
    process.exit(1);
  }
}
