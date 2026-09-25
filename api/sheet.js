const https = require('https');

const GOOGLE_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/194ei4yzOTUMrnMLe1fseis__QQnRGk6rwA6U_WSVEUA/export?format=csv&gid=1400833008';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');

  if (req.method === 'OPTIONS') {
    if (res.status) res.status(204).end();
    else { res.statusCode = 204; res.end(); }
    return;
  }

  function fetchStream(url) {
    https.get(url, (googleRes) => {
      if (googleRes.statusCode >= 300 && googleRes.statusCode < 400 && googleRes.headers.location) {
        return fetchStream(googleRes.headers.location);
      }
      if (googleRes.statusCode !== 200) {
        if (res.status) res.status(502).json({ error: `Google Sheets returned ${googleRes.statusCode}` });
        else { res.statusCode = 502; res.end(JSON.stringify({ error: `Google Sheets returned ${googleRes.statusCode}` })); }
        return;
      }
      googleRes.pipe(res);
    }).on('error', (err) => {
      console.error('Sheet proxy error:', err);
      if (res.status) res.status(500).json({ error: err.message });
      else { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })); }
    });
  }

  fetchStream(GOOGLE_SHEETS_URL);
};
