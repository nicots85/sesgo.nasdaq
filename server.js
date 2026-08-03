require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3005;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Cargar módulos una sola vez
let getBias, newsHandler;
try {
  getBias = require('./api/bias').getBias;
  console.log('✓ bias.js cargado');
} catch (e) {
  console.error('✗ Error cargando bias.js:', e.message);
}
try {
  newsHandler = require('./api/news').handler;
  console.log('✓ news.js cargado');
} catch (e) {
  console.error('✗ Error cargando news.js:', e.message);
}

const server = http.createServer(async (req, res) => {
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.url}`);

  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/api/bias' && getBias) {
      try {
        const result = await getBias();
        if (!res.headersSent) {
          res.writeHead(200);
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        console.error('✗ Error en /api/bias:', err.message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    } else if (req.url === '/api/news' && newsHandler) {
      await newsHandler(req, res);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
    return;
  }

  // Static files
  let filePath = path.join(process.cwd(), req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(process.cwd(), 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n=== NASDAQ BRIEFING LOCAL ===`);
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`Presioná Ctrl+C para detener\n`);
});
