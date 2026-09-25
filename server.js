const http = require('http');
const fs = require('fs');
const path = require('path');
const searchHandler = require('./api/search.js');
const sheetHandler = require('./api/sheet.js');
const syncHandler = require('./api/sync.js');

const PORT = process.env.PORT || 8081;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  // CORS & caching headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // Helper adapter for Vercel req/res style
  const makeAdapter = () => {
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const reqAdapter = {
      method: req.method,
      url: req.url,
      query,
      headers: req.headers
    };
    const resAdapter = {
      setHeader: (k, v) => res.setHeader(k, v),
      status: (code) => {
        res.statusCode = code;
        return {
          json: (data) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(data));
          },
          end: (data) => res.end(data)
        };
      },
      pipe: res.pipe ? res.pipe.bind(res) : null
    };
    return { reqAdapter, resAdapter };
  };

  // Route 1: Serverless Search API
  if (pathname === '/api/search') {
    const { reqAdapter, resAdapter } = makeAdapter();
    try {
      await searchHandler(reqAdapter, resAdapter);
    } catch (err) {
      console.error('Search handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Route 2: Google Sheets Proxy with CORS
  if (pathname === '/api/sheet') {
    try {
      await sheetHandler(req, res);
    } catch (err) {
      console.error('Sheet handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Route 3: Sync Trigger API
  if (pathname === '/api/sync') {
    const { reqAdapter, resAdapter } = makeAdapter();
    try {
      await syncHandler(reqAdapter, resAdapter);
    } catch (err) {
      console.error('Sync handler error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Route 2: Static file serving
  let filePath = pathname === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, pathname);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403 Forbidden');
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': fs.statSync(filePath).size,
    'Cache-Control': ext === '.json' || ext === '.csv' ? 'public, max-age=3600' : 'no-cache'
  });

  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Sangathan Search server running on http://localhost:${PORT}`);
});
