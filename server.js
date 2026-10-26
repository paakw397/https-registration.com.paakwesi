const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const publicDirectory = path.join(__dirname, 'public');
const sessionDuration = 8 * 60 * 60 * 1000;
const rateLimits = new Map();

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function getCookie(request, name) {
  const cookieHeader = request.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function checkRateLimit(key, limit, interval) {
  const now = Date.now();
  const attempts = (rateLimits.get(key) || []).filter((time) => now - time < interval);
  if (attempts.length >= limit) {
    rateLimits.set(key, attempts);
    return false;
  }
  attempts.push(now);
  rateLimits.set(key, attempts);
  return true;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Request body too large');
  }
  return JSON.parse(body || '{}');
}

function csvCell(value) {
  let cell = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

function createApplication({ adminPassword = process.env.ADMIN_PASSWORD, dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'registrations.json'), siteUrl = process.env.SITE_URL } = {}) {
  if (typeof adminPassword !== 'string' || adminPassword.length < 10) {
    throw new Error('Set ADMIN_PASSWORD to a value with at least 10 characters before starting the server.');
  }
  let publicSiteUrl = '';
  if (siteUrl) {
    let parsedSiteUrl;
    try {
      parsedSiteUrl = new URL(siteUrl);
    } catch {
      throw new Error('SITE_URL must be the public HTTPS URL of the site, such as https://signup.example.com.');
    }
    if (parsedSiteUrl.protocol !== 'https:' || parsedSiteUrl.pathname !== '/' || parsedSiteUrl.search || parsedSiteUrl.hash) {
      throw new Error('SITE_URL must be the public HTTPS origin without a path, query, or fragment.');
    }
    publicSiteUrl = parsedSiteUrl.origin;
  }

  const sessions = new Map();
  let writes = Promise.resolve();

  async function registrations() {
    try {
      return JSON.parse(await fs.readFile(dataFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function updateRegistrations(update) {
    const operation = writes.then(async () => {
      const current = await registrations();
      const next = update(current);
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryFile, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temporaryFile, dataFile);
      return next;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function sessionFor(request) {
    const token = getCookie(request, 'owner_session');
    const expiresAt = sessions.get(token);
    if (!token || !expiresAt || expiresAt < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function secureCookie(request) {
    return request.socket.encrypted || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const clientAddress = request.socket.remoteAddress || 'unknown';
    if (url.pathname === '/owner' || url.pathname.startsWith('/api/')) {
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }

    try {
      if (request.method === 'GET' && url.pathname === '/robots.txt') {
        const sitemapLine = publicSiteUrl ? `Sitemap: ${publicSiteUrl}/sitemap.xml\n` : '';
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        response.end(`User-agent: *\nAllow: /\nDisallow: /api/\n${sitemapLine}`);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
        if (!publicSiteUrl) {
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('Set SITE_URL to the public HTTPS domain to enable the sitemap.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        response.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicSiteUrl}/</loc></url></urlset>`);
        return;
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/owner')) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(url.pathname === '/owner' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
        });
        response.end(await fs.readFile(path.join(publicDirectory, 'index.html')));
        return;
      }

      const staticFiles = {
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
        '/replit-background.svg': ['replit-background.svg', 'image/svg+xml'],
      };
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [fileName, contentType] = staticFiles[url.pathname];
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        response.end(await fs.readFile(path.join(publicDirectory, fileName)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/register') {
        if (!checkRateLimit(`register:${clientAddress}`, 20, 60 * 60 * 1000)) {
          sendJson(response, 429, { error: 'Too many attempts. Please try again later.' });
          return;
        }
        let input;
        try {
          input = await readBody(request);
        } catch {
          sendJson(response, 400, { error: 'Please submit a valid form.' });
          return;
        }
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
        const digitCount = phone.replace(/\D/g, '').length;
        if (name.length < 2 || name.length > 80) {
          sendJson(response, 400, { error: 'Enter a name between 2 and 80 characters.' });
          return;
        }
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(response, 400, { error: 'Enter a valid email address.' });
          return;
        }
        if (phone.length > 24 || !/^[+\d().\s-]+$/.test(phone) || digitCount < 7 || digitCount > 15) {
          sendJson(response, 400, { error: 'Enter a valid phone number.' });
          return;
        }
        if (input.consent !== true) {
          sendJson(response, 400, { error: 'Please confirm that the organizer may access your contact details.' });
          return;
        }

        let duplicate = false;
        await updateRegistrations((current) => {
          if (current.some((entry) => entry.email === email)) {
            duplicate = true;
            return current;
          }
          return [...current, {
            id: crypto.randomUUID(),
            name,
            email,
            phone,
            createdAt: new Date().toISOString(),
          }];
        });
        if (duplicate) {
          sendJson(response, 409, { error: 'This email is already registered. Contact the organizer if your details need to change.' });
          return;
        }
        sendJson(response, 201, { message: 'You are registered. The organizer has received your details.' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/owner/login') {
        if (!checkRateLimit(`login:${clientAddress}`, 8, 15 * 60 * 1000)) {
          sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
          return;
        }
        let input;
        try {
          input = await readBody(request);
        } catch {
          sendJson(response, 400, { error: 'Please enter the owner password.' });
          return;
        }
        if (typeof input.password !== 'string' || !safeEqual(input.password, adminPassword)) {
          sendJson(response, 401, { error: 'That password did not match.' });
          return;
        }
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, Date.now() + sessionDuration);
        sendJson(response, 200, { message: 'Signed in.' }, {
          'Set-Cookie': `owner_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secureCookie(request)}`,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/owner/logout') {
        sessions.delete(getCookie(request, 'owner_session'));
        sendJson(response, 200, { message: 'Signed out.' }, {
          'Set-Cookie': `owner_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(request)}`,
        });
        return;
      }

      if (url.pathname.startsWith('/api/owner/')) {
        if (!sessionFor(request)) {
          sendJson(response, 401, { error: 'Owner sign-in required.' });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/owner/session') {
          sendJson(response, 200, { authenticated: true });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/owner/registrations') {
          const entries = await registrations();
          sendJson(response, 200, { registrations: entries });
          return;
        }
        const registrationMatch = url.pathname.match(/^\/api\/owner\/registrations\/([0-9a-f-]{36})$/i);
        if (request.method === 'DELETE' && registrationMatch) {
          const registrationId = registrationMatch[1];
          let deleted = false;
          await updateRegistrations((current) => {
            const remaining = current.filter((entry) => entry.id !== registrationId);
            deleted = remaining.length !== current.length;
            return remaining;
          });
          if (!deleted) {
            sendJson(response, 404, { error: 'Registration not found.' });
            return;
          }
          sendJson(response, 200, { message: 'Registration deleted.' });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/owner/export.csv') {
          const entries = await registrations();
          const rows = [['Name', 'Email', 'Phone', 'Registered at'], ...entries.map((entry) => [entry.name, entry.email, entry.phone, entry.createdAt])];
          const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
          response.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="registrations.csv"',
            'Cache-Control': 'no-store',
          });
          response.end(csv);
          return;
        }
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong. Please try again.' });
      else response.end();
    }
  });

  return server;
}

if (require.main === module) {
  try {
    const server = createApplication();
    const port = Number(process.env.PORT) || 3000;
    server.listen(port, '0.0.0.0', () => {
      console.log(`Student sign-up app running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApplication };