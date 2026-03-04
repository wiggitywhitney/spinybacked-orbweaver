// ABOUTME: Test fixture — JavaScript file with various function types for classification testing
import http from 'node:http';

// Exported async function — service entry point
export async function startServer(port) {
  const server = http.createServer(handleRequest);
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

// Exported sync function — utility
export function createConfig(options) {
  return {
    host: options.host || 'localhost',
    port: options.port || 3000,
  };
}

// Non-exported async function — internal
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await readBody(req);
  const response = processRoute(url.pathname, body);
  res.writeHead(response.status);
  res.end(JSON.stringify(response.body));
}

// Non-exported sync function — pure utility
function processRoute(pathname, body) {
  switch (pathname) {
    case '/health':
      return { status: 200, body: { ok: true } };
    case '/echo':
      return { status: 200, body };
    default:
      return { status: 404, body: { error: 'Not found' } };
  }
}

// Arrow function assigned to const — exported
export const middleware = async (req, res, next) => {
  req.startTime = Date.now();
  await next();
  const duration = Date.now() - req.startTime;
  console.log(`${req.method} ${req.url} ${duration}ms`);
};

// Arrow function — non-exported
const readBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
};

// Short utility function
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
