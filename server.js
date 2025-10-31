// server.js
'use strict';

/**
 * server.js (fix) - autogenerate .env + admin user + bcrypt-hashed upload token
 *
 * Behavior:
 * - If .env missing -> create it, generate UPLOAD_TOKEN (plaintext in-memory for first-run display),
 *   hash it with bcrypt and write UPLOAD_TOKEN_HASH to .env. Also generate SESSION_SECRET.
 * - If users file missing or contains zero users -> prompt in terminal for admin password (or generate fallback),
 *   hash it with bcrypt and write default admin user (username: admin).
 * - /upload requires Authorization: Bearer <UPLOAD_TOKEN> (validated with bcrypt.compareSync against UPLOAD_TOKEN_HASH
 *   or against the in-memory token generated this run).
 * - Dashboard login uses username/password (bcrypt). Settings allow password/email change and setting a new upload token.
 *
 * This version avoids top-level await and ensures init completes then starts server.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const stream = require('stream');
const { pipeline } = require('stream/promises');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const {
  DATA_DIR, USERS_FILE, IMAGES_FILE,
  listImages, addImage, removeImage,
  listUsers, findUser, createUser, updateUser, deleteUser
} = require('./lib/db');

const APP_ROOT = path.resolve(__dirname);
const ENV_PATH = path.join(APP_ROOT, '.env');

const DEFAULTS = {
  PORT: 3000,
  UPLOAD_DIR: 'uploads',
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  RATE_LIMIT_TOKENS: 20,
  RATE_LIMIT_REFILL: 1
};

const DEFAULT_BACKGROUND = { type: 'color', value: '#05080f' };
const TEMPLATE_BACKGROUNDS = [
  'https://images.unsplash.com/photo-1526481280695-3c469be254d2?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1451188214936-ec16af5ca155?auto=format&fit=crop&w=1600&q=80'
];

// In-memory plaintext upload token if generated on this run (shown once in console)
let initialUploadTokenPlain = null;
// we do not store admin plaintext normally; only show generated fallback in non-TTY case
let initialAdminPasswordPlain = null;

// Utility
function randHex(len = 32) { return crypto.randomBytes(len).toString('hex'); }

// Ensure .env exists and contains UPLOAD_TOKEN_HASH and SESSION_SECRET
function ensureEnv() {
  // if exists, load it and append missing values if any
  if (fs.existsSync(ENV_PATH)) {
    require('dotenv').config();
    let changed = false;
    const kv = Object.assign({}, process.env);
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    if (!kv.UPLOAD_TOKEN_HASH) {
      // create new random token, store hash and keep plaintext in memory
      const plain = randHex(24);
      const hash = bcrypt.hashSync(plain, 10);
      kv.UPLOAD_TOKEN_HASH = hash;
      initialUploadTokenPlain = plain;
      changed = true;
    }
    if (!kv.SESSION_SECRET) {
      kv.SESSION_SECRET = randHex(32);
      changed = true;
    }
    if (changed) {
      // rebuild and write .env preserving header comment
      const header = '# Auto-generated .env - do not commit to git';
      const content = [
        header,
        `PORT=${kv.PORT || DEFAULTS.PORT}`,
        `UPLOAD_DIR=${kv.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
        `MAX_UPLOAD_BYTES=${kv.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
        `RATE_LIMIT_TOKENS=${kv.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
        `RATE_LIMIT_REFILL=${kv.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
        `SESSION_SECRET=${kv.SESSION_SECRET}`,
        `UPLOAD_TOKEN_HASH=${kv.UPLOAD_TOKEN_HASH}`
      ].join('\n') + '\n';
      fs.writeFileSync(ENV_PATH, content, 'utf8');
      require('dotenv').config();
    }
    return false;
  }

  // create new .env and return plaintext upload token
  const uploadTokenPlain = randHex(24);
  const uploadTokenHash = bcrypt.hashSync(uploadTokenPlain, 10);
  const sessionSecret = randHex(32);

  const content = [
    '# Auto-generated .env - do not commit to git',
    `PORT=${process.env.PORT || DEFAULTS.PORT}`,
    `UPLOAD_DIR=${process.env.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
    `MAX_UPLOAD_BYTES=${process.env.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
    `RATE_LIMIT_TOKENS=${process.env.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
    `RATE_LIMIT_REFILL=${process.env.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
    `SESSION_SECRET=${sessionSecret}`,
    `UPLOAD_TOKEN_HASH=${uploadTokenHash}`
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  require('dotenv').config();

  // store plaintext in memory for one-time display/generation of .sxcu
  initialUploadTokenPlain = uploadTokenPlain;
  return uploadTokenPlain;
}

// Prompt helper (hidden input) -- returns Promise<string>
// Prompt helper (hidden input) -- returns Promise<string>
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    // păstrăm funcția originală sub un nume diferit pentru a evita recursiunea
    const origWrite = rl._writeToOutput;

    rl._writeToOutput = function (stringToWrite) {
      if (rl.stdoutMuted) {
        // afișăm un asterisk în locul caracterelor tastate pentru feedback
        rl.output.write('*');
      } else {
        // apelăm funcția originală stocată
        origWrite.call(rl, stringToWrite);
      }
    };

    rl.question(query, (answer) => {
      rl.history = rl.history.slice(1);
      rl.close();
      resolve(answer);
    });
    rl.stdoutMuted = true;
  });
}

// Ensure data dir and default admin user; ask for password in terminal if needed.
// Returns plaintext admin password only in the non-interactive fallback case (or null).
async function ensureDataAndAdminSync() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // If users file exists and has at least one user, do nothing
  if (fs.existsSync(USERS_FILE)) {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      if (Array.isArray(parsed.users) && parsed.users.length > 0) {
        return null;
      }
      // else continue to create admin
    } catch (e) {
      // fall through to create default admin
    }
  }

  // Need to create admin user
  const username = 'admin';
  let adminPassPlain = null;

  // If we have a TTY, prompt for password (with confirmation). If no TTY, create random and print.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write('\nNo users found. Creating default admin user.\n');
    // prompt loop up to 3 attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      const p1 = (await promptHidden('Enter password for admin (input hidden): ')) || '';
      process.stdout.write('\n');
      if (!p1) {
        console.log('Password cannot be empty. Try again.\n');
        continue;
      }
      const p2 = (await promptHidden('Confirm password: ')) || '';
      process.stdout.write('\n');
      if (p1 !== p2) {
        console.log('Passwords do not match. Try again.\n');
        continue;
      }
      adminPassPlain = p1;
      break;
    }
    if (!adminPassPlain) {
      console.log('Failed to set password interactively. Falling back to generated password (printed once).');
      adminPassPlain = randHex(8);
      initialAdminPasswordPlain = adminPassPlain;
    }
  } else {
    // Non-interactive environment: generate random password and show it (so admin can copy it once)
    adminPassPlain = randHex(8);
    initialAdminPasswordPlain = adminPassPlain;
    console.log('\nNo TTY detected: generated admin password (one-time display):', adminPassPlain, '\n');
  }

  const hash = bcrypt.hashSync(adminPassPlain, 10);
  const defaultUser = {
    username: username,
    password_hash: hash,
    email: 'admin@example.com',
    created_at: Date.now(),
    preferences: { background: Object.assign({}, DEFAULT_BACKGROUND) }
  };

  // Write users JSON (simple structure)
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [defaultUser] }, null, 2), 'utf8');
  return adminPassPlain;
}

// Update UPLOAD_TOKEN_HASH in .env (called when admin changes token in Settings)
function setUploadTokenHashInEnv(newHash) {
  let raw = '';
  if (fs.existsSync(ENV_PATH)) raw = fs.readFileSync(ENV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const kv = {};
  for (const l of lines) {
    if (!l || l.trim().startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i === -1) continue;
    kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  kv.UPLOAD_TOKEN_HASH = newHash;
  kv.SESSION_SECRET = kv.SESSION_SECRET || randHex(32);

  const header = '# Auto-generated .env - do not commit to git';
  const content = [
    header,
    `PORT=${kv.PORT || DEFAULTS.PORT}`,
    `UPLOAD_DIR=${kv.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
    `MAX_UPLOAD_BYTES=${kv.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
    `RATE_LIMIT_TOKENS=${kv.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
    `RATE_LIMIT_REFILL=${kv.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
    `SESSION_SECRET=${kv.SESSION_SECRET}`,
    `UPLOAD_TOKEN_HASH=${kv.UPLOAD_TOKEN_HASH}`
  ].join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, content, 'utf8');
  process.env.UPLOAD_TOKEN_HASH = kv.UPLOAD_TOKEN_HASH;
}

// Start server after initialization
async function init() {
  try {
    // 1) ensure .env and capture token if created now
    const maybeToken = ensureEnv(); // may set initialUploadTokenPlain
    // 2) ensure users file and default admin creation (interactive if possible)
    await ensureDataAndAdminSync(); // sets initialAdminPasswordPlain if fallback

    // reload env to be safe
    require('dotenv').config();

    // read config from env
    const PORT = parseInt(process.env.PORT || DEFAULTS.PORT, 10);
    const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR);
    const BACKGROUND_DIR = path.join(UPLOAD_DIR, 'backgrounds');
    const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES, 10);
    const RATE_LIMIT_TOKENS = parseInt(process.env.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS, 10);
    const RATE_LIMIT_REFILL = parseFloat(process.env.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL, 10);
    let UPLOAD_TOKEN_HASH = (process.env.UPLOAD_TOKEN_HASH || '').trim();
    const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();

    if (!UPLOAD_TOKEN_HASH || !SESSION_SECRET) {
      console.error('UPLOAD_TOKEN_HASH or SESSION_SECRET missing in .env. Aborting.');
      process.exit(1);
    }

    // create uploads dir
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    if (!fs.existsSync(BACKGROUND_DIR)) fs.mkdirSync(BACKGROUND_DIR, { recursive: true });

    // Multer
    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const safe = (file.originalname || 'file').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${uuidv4()}-${safe}`);
      }
    });
    const fileFilter = (req, file, cb) => {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image/* allowed'));
      }
      cb(null, true);
    };
    const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_UPLOAD_BYTES } });
    const backgroundStorage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, BACKGROUND_DIR),
      filename: (req, file, cb) => {
        const safe = (file.originalname || 'background').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${uuidv4()}-${safe}`);
      }
    });
    const backgroundUpload = multer({ storage: backgroundStorage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());
    app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
    app.use('/backgrounds', express.static(BACKGROUND_DIR, { maxAge: '7d' }));

    // rate limiter in-memory
    const rateBuckets = new Map();
    function allowRate(ip) {
      let b = rateBuckets.get(ip);
      const now = Date.now() / 1000;
      if (!b) { b = { tokens: RATE_LIMIT_TOKENS, last: now }; rateBuckets.set(ip, b); }
      const elapsed = Math.max(0, now - b.last);
      b.tokens = Math.min(RATE_LIMIT_TOKENS, b.tokens + elapsed * RATE_LIMIT_REFILL);
      b.last = now;
      if (b.tokens >= 1) { b.tokens -= 1; return true; }
      return false;
    }

    // Session cookie signing
    function signSession(username, ts) {
      const payload = `${username}.${ts}`;
      const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
      return `${payload}.${hmac}`;
    }
    function verifySessionCookie(cookieValue) {
      if (!cookieValue) return null;
      const parts = cookieValue.split('.');
      if (parts.length < 3) return null;
      // last part is hmac, second last is timestamp, rest is username (to allow dots in username)
      const providedHmac = parts.pop();
      const ts = parts.pop();
      const username = parts.join('.');
      const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${username}.${ts}`).digest('hex');
      try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(providedHmac, 'hex'))) return null;
      } catch (e) { return null; }
      const tsNum = parseInt(ts, 10);
      if (isNaN(tsNum)) return null;
      const age = Date.now() - tsNum;
      const maxAge = 30 * 24 * 60 * 60 * 1000;
      if (age > maxAge) return null;
      return username;
    }

    function checkAuthFromReq(req) {
      const cookie = req.cookies && req.cookies['session'];
      if (cookie) {
        const username = verifySessionCookie(cookie);
        if (username) return username;
      }
      return null;
    }

    // verify upload token
    function verifyUploadToken(candidate) {
      if (!candidate) return false;
      if (initialUploadTokenPlain && candidate === initialUploadTokenPlain) return true;
      try {
        return bcrypt.compareSync(candidate, UPLOAD_TOKEN_HASH);
      } catch (e) {
        return false;
      }
    }

    // helper: set new upload token hash persistently
    function persistNewUploadTokenHash(newHash) {
      setUploadTokenHashInEnv(newHash);
      UPLOAD_TOKEN_HASH = newHash;
    }

    // helpers
    function getOrigin(req) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.headers['host'];
      return `${proto}://${host}`;
    }
    function jsonError(res, status = 400, msg = 'error') {
      return res.status(status).json({ success: false, error: msg });
    }

    function normalizeBackgroundPref(pref) {
      if (!pref || typeof pref !== 'object') return Object.assign({}, DEFAULT_BACKGROUND);
      const type = pref.type;
      const value = typeof pref.value === 'string' ? pref.value.trim() : '';
      if (type === 'color') {
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
          return { type: 'color', value: value.toLowerCase() };
        }
        return Object.assign({}, DEFAULT_BACKGROUND);
      }
      if (type === 'template') {
        if (TEMPLATE_BACKGROUNDS.includes(value)) {
          return { type: 'template', value };
        }
        return Object.assign({}, DEFAULT_BACKGROUND);
      }
      if (type === 'image') {
        if (value.startsWith('/backgrounds/')) {
          return { type: 'image', value };
        }
        return Object.assign({}, DEFAULT_BACKGROUND);
      }
      return Object.assign({}, DEFAULT_BACKGROUND);
    }

    function getBackgroundPreference(user) {
      return normalizeBackgroundPref(user && user.preferences && user.preferences.background || DEFAULT_BACKGROUND);
    }

    function setBackgroundPreference(username, pref) {
      const sanitized = normalizeBackgroundPref(pref);
      const user = findUser(username);
      if (!user) return false;
      const prefs = Object.assign({}, user.preferences || {});
      prefs.background = sanitized;
      const ok = updateUser(username, { preferences: prefs });
      return ok ? sanitized : false;
    }

    function userForClient(user) {
      if (!user) return null;
      return {
        username: user.username,
        email: user.email || '',
        created_at: user.created_at,
        backgroundPreference: getBackgroundPreference(user)
      };
    }

    // Routes

    app.get('/', (req, res) => {
      try {
        const username = checkAuthFromReq(req);
        if (username) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
      } catch (err) {
        console.error('Error serving /', err);
        return jsonError(res, 500, 'Internal server error');
      }
    });

    app.get('/healthz', (req, res) => res.json({ ok: true }));

    // View page for Discord/OG embedding: green background and OG tags
    app.get('/i/:filename/view', async (req, res) => {
      try {
        const filename = req.params.filename;
        const filePath = path.join(UPLOAD_DIR, filename);
        // Prevent path traversal
        if (path.relative(UPLOAD_DIR, filePath).startsWith('..')) return jsonError(res, 400, 'Invalid filename');
        // ensure file exists
        await fsp.access(filePath, fs.constants.R_OK);
        const origin = getOrigin(req);
        const imageUrl = `${origin}/i/${encodeURIComponent(filename)}`;
        const pageUrl = `${origin}/i/${encodeURIComponent(filename)}/view`;
        const imageTitle = path.basename(filename);


        // Minimal HTML with green background and OG tags for Discord
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Image view</title>

  <!-- Open Graph for Discord and social previews -->
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="ADEdge">
  <meta property="og:title" content="${escapeHtml(imageTitle)}">
  <meta property="og:description" content="uploaded on ADEdge">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="Shared image">
  <meta name="twitter:card" content="summary_large_image">

  <style>
    html,body{height:100%;margin:0}
    body{display:flex;align-items:center;justify-content:center;background:#0f9d58;color:#0a0a0a;font-family:Arial,Helvetica,sans-serif}
    .container{max-width:90%;max-height:90%;display:flex;align-items:center;justify-content:center;flex-direction:column}
    img{max-width:100%;max-height:80vh;border:6px solid rgba(255,255,255,0.06);box-shadow:0 6px 18px rgba(0,0,0,0.2);border-radius:8px}
    .note{margin-top:12px;color:rgba(255,255,255,0.9);font-size:14px}
  </style>
</head>
<body>
  <div class="container">
    <img src="${escapeHtml(imageUrl)}" alt="Shared image">
    <div class="note">This image was uploaded on ADEdge.</div>
  </div>
</body>
</html>`;

        // Serve HTML; let Discord fetch OG tags
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Very small cache to reduce repeated hits, but allow re-fetch if changed
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.status(200).send(html);
      } catch (err) {
        return jsonError(res, 404, 'Not found');
      }
    });

    // Serve raw image
    app.get('/i/:filename', async (req, res) => {
      try {
        const filename = req.params.filename;
        const filePath = path.join(UPLOAD_DIR, filename);
        if (path.relative(UPLOAD_DIR, filePath).startsWith('..')) return jsonError(res, 400, 'Invalid filename');
        await fsp.access(filePath, fs.constants.R_OK);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.sendFile(filePath);
      } catch (err) {
        return jsonError(res, 404, 'Not found');
      }
    });

    // Upload endpoint (ShareX)
    app.post('/upload', async (req, res) => {
      try {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        if (!allowRate(ip)) return jsonError(res, 429, 'Too many requests');

        const auth = (req.headers['authorization'] || '');
        if (!auth.startsWith('Bearer ')) return jsonError(res, 401, 'Missing Authorization header');
        const tokenCandidate = auth.slice(7).trim();
        if (!verifyUploadToken(tokenCandidate)) return jsonError(res, 401, 'Invalid upload token');

        const contentType = (req.headers['content-type'] || '').toLowerCase();

        if (contentType.startsWith('multipart/form-data')) {
          return upload.single('file')(req, res, function (err) {
            if (err) { console.error('multer error:', err); return jsonError(res, 400, err.message || 'Upload error'); }
            if (!req.file) return jsonError(res, 400, 'No file provided (field name: file)');
            const filename = req.file.filename;
            // Note: we return the raw image URL here; the generated .sxcu will append /view when configured
            const url = `${getOrigin(req)}/i/${encodeURIComponent(filename)}`;
            const id = uuidv4();
            addImage({ id, filename, originalname: req.file.originalname, size: req.file.size, url, uploaded_at: Date.now() });
            return res.json({ success: true, url, delete_url: `${getOrigin(req)}/api/images/${id}` });
          });
        }

        // binary raw upload
        const maxBytes = MAX_UPLOAD_BYTES;
        let totalBytes = 0;
        const filenameHeader = req.headers['x-filename'] || `${Date.now()}.png`;
        const safe = String(filenameHeader).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const filename = `${Date.now()}-${uuidv4()}-${safe}`;
        const filepath = path.join(UPLOAD_DIR, filename);
        const writeStream = fs.createWriteStream(filepath, { flags: 'wx' });

        const counter = new stream.Transform({
          transform(chunk, enc, cb) {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) return cb(new Error('File too large'));
            cb(null, chunk);
          }
        });

        try {
          await pipeline(req, counter, writeStream);
        } catch (err) {
          try { await fsp.unlink(filepath); } catch (e) {}
          console.error('Binary upload failed:', err.message || err);
          return jsonError(res, err.message === 'File too large' ? 413 : 400, err.message || 'Upload error');
        }

        const url = `${getOrigin(req)}/i/${encodeURIComponent(filename)}`;
        const id = uuidv4();
        addImage({ id, filename, originalname: filenameHeader, size: totalBytes, url, uploaded_at: Date.now() });
        return res.json({ success: true, url, delete_url: `${getOrigin(req)}/api/images/${id}` });

      } catch (err) {
        console.error('Unexpected upload error:', err);
        return jsonError(res, 500, 'Internal server error');
      }
    });

    // Dashboard login (username/password)
    app.post('/api/login', async (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) return jsonError(res, 400, 'username and password required');
      const user = findUser(username);
      if (!user) return jsonError(res, 401, 'Invalid credentials');
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return jsonError(res, 401, 'Invalid credentials');
      const ts = Date.now();
      const cookieVal = signSession(username, ts);
      // set cookie with explicit path and maxAge; secure only in production
      res.cookie('session', cookieVal, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        secure: (process.env.NODE_ENV === 'production')
      });
      return res.json({ success: true, username: user.username, email: user.email });
    });

    // Logout
    app.post('/api/logout', (req, res) => {
      res.clearCookie('session');
      return res.json({ success: true });
    });

    // Me
    function handleAccountMe(req, res) {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const user = findUser(username);
      if (!user) return jsonError(res, 404, 'User not found');
      return res.json({ success: true, user: userForClient(user) });
    }

    app.get('/api/me', handleAccountMe);
    app.get('/api/account/me', handleAccountMe);

    async function handleAccountSettings(req, res) {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const { email, currentPassword, newPassword, newUploadToken } = req.body || {};
      const user = findUser(username);
      if (!user) return jsonError(res, 404, 'User not found');

      if (newPassword) {
        if (!currentPassword) return jsonError(res, 400, 'currentPassword required to change password');
        const ok = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok) return jsonError(res, 401, 'Current password incorrect');
        const newHash = await bcrypt.hash(newPassword, 10);
        updateUser(username, { password_hash: newHash, email: email || user.email });
      } else if (email) {
        updateUser(username, { email });
      }

      if (newUploadToken) {
        if (!currentPassword) return jsonError(res, 400, 'currentPassword required to change upload token');
        const ok2 = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok2) return jsonError(res, 401, 'Current password incorrect (for upload token change)');
        const newTokenHash = await bcrypt.hash(newUploadToken, 10);
        persistNewUploadTokenHash(newTokenHash);
        // set in-memory plaintext so .sxcu generation in same runtime can embed it
        initialUploadTokenPlain = newUploadToken;
      }

      return res.json({ success: true, message: 'Settings updated' });
    }

    app.post('/api/settings', handleAccountSettings);
    app.post('/api/account/settings', handleAccountSettings);

    app.get('/api/account/background/templates', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      return res.json({ success: true, templates: TEMPLATE_BACKGROUNDS, defaultBackground: DEFAULT_BACKGROUND });
    });

    app.post('/api/account/background', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const preference = req.body && req.body.preference;
      if (!preference) return jsonError(res, 400, 'preference required');
      const saved = setBackgroundPreference(username, preference);
      if (!saved) return jsonError(res, 500, 'Failed to save preference');
      return res.json({ success: true, backgroundPreference: saved });
    });

    app.post('/api/account/background/upload', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      backgroundUpload.single('background')(req, res, err => {
        if (err) {
          console.error('Background upload error', err);
          return jsonError(res, 400, err.message || 'Upload failed');
        }
        if (!req.file) return jsonError(res, 400, 'No file uploaded');
        const fileUrl = `/backgrounds/${req.file.filename}`;
        const saved = setBackgroundPreference(username, { type: 'image', value: fileUrl });
        if (!saved) return jsonError(res, 500, 'Failed to save preference');
        return res.json({ success: true, backgroundPreference: saved });
      });
    });

    app.get('/api/account/users', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');
      const users = listUsers().map(userForClient);
      return res.json({ success: true, users });
    });

    app.post('/api/account/users', async (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');
      const { newUsername, email, password } = req.body || {};
      if (!newUsername || !email || !password) return jsonError(res, 400, 'newUsername, email and password required');
      const trimmedUsername = newUsername.trim();
      const trimmedEmail = email.trim();
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(trimmedUsername)) return jsonError(res, 400, 'Username must be 3-32 characters');
      if (!/^.+@.+\..+$/.test(trimmedEmail)) return jsonError(res, 400, 'Email invalid');
      if (password.length < 6) return jsonError(res, 400, 'Password must be at least 6 characters');
      const existingUser = findUser(trimmedUsername);
      if (existingUser) return jsonError(res, 409, 'Username already exists');
      const emailTaken = listUsers().some(u => (u.email || '').toLowerCase() === trimmedEmail.toLowerCase());
      if (emailTaken) return jsonError(res, 409, 'Email already exists');
      const hashed = await bcrypt.hash(password, 10);
      createUser({
        username: trimmedUsername,
        email: trimmedEmail,
        password_hash: hashed,
        created_at: Date.now(),
        preferences: { background: Object.assign({}, DEFAULT_BACKGROUND) }
      });
      return res.json({ success: true, user: userForClient(findUser(trimmedUsername)) });
    });

    app.delete('/api/account/users/:username', (req, res) => {
      const actor = checkAuthFromReq(req);
      if (!actor) return jsonError(res, 401, 'Unauthorized');
      if (actor !== 'admin') return jsonError(res, 403, 'Admin access required');
      const target = req.params.username;
      if (!target) return jsonError(res, 400, 'username required');
      if (target === 'admin') return jsonError(res, 400, 'Cannot delete admin account');
      const ok = deleteUser(target);
      if (!ok) return jsonError(res, 404, 'User not found');
      return res.json({ success: true });
    });

    // Images list (dashboard)
    app.get('/api/images', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const images = listImages();
      return res.json({ success: true, images });
    });

    // Upload from dashboard
    app.post('/api/upload', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      return upload.single('file')(req, res, function (err) {
        if (err) { console.error('multer api/upload err', err); return jsonError(res, 400, err.message || 'Upload error'); }
        if (!req.file) return jsonError(res, 400, 'No file');
        const filename = req.file.filename;
        const url = `${getOrigin(req)}/i/${encodeURIComponent(filename)}`;
        const id = uuidv4();
        addImage({ id, filename, originalname: req.file.originalname, size: req.file.size, url, uploaded_at: Date.now() });
        return res.json({ success: true, url });
      });
    });

    // Delete
    app.delete('/api/images/:id', async (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const id = req.params.id;
      const images = listImages();
      const item = images.find(i => i.id === id);
      if (!item) return jsonError(res, 404, 'Not found');
      const filepath = path.join(UPLOAD_DIR, item.filename);
      try {
        await fsp.unlink(filepath).catch(() => {});
        const ok = removeImage(id);
        return res.json({ success: ok });
      } catch (err) {
        console.error('Delete error:', err);
        return jsonError(res, 500, 'Delete failed');
      }
    });

    // Generate .sxcu (embed token if generated this run or set in settings)
    // Modified to use /view at final URL so ShareX will produce Discord-friendly links
    function handleGenerateSxcu(req, res) {
      const username = checkAuthFromReq(req);
      if (username === null) return jsonError(res, 401, 'Unauthorized');

      const modeInput = req.query.mode || req.query.type || (req.body && req.body.mode) || 'binary';
      const mode = String(modeInput).toLowerCase();
      const origin = getOrigin(req);

      // Folosim token-ul din memoria curentă sau din .env
      let token;
      if (initialUploadTokenPlain) token = initialUploadTokenPlain;
      else if (process.env.UPLOAD_TOKEN_HASH) {
        // În acest caz nu avem plaintext-ul, deci trebuie să generăm unul nou
        token = randHex(24);
        const newHash = bcrypt.hashSync(token, 10);
        persistNewUploadTokenHash(newHash); // actualizează .env și memoria
        initialUploadTokenPlain = token;
        console.log(`[INFO] Generated new upload token for ShareX: ${token}`);
      } else {
        return jsonError(res, 500, 'No upload token available');
      }

      const headers = { Authorization: `Bearer ${token}` };

      const base = {
        Version: "13.5.0",
        Name: `ShareX - ${mode === 'multipart' ? 'Multipart' : 'Binary'} uploader (${origin})`,
        DestinationType: "ImageUploader",
        RequestMethod: "POST",
        RequestURL: `${origin}/upload`,
        Headers: headers
      };

      // Important: instruct ShareX to use the returned "url" and append /view so that Discord reads OG tags.
      let obj;
      if (mode === 'multipart') {
        obj = Object.assign({}, base, {
          Body: "MultipartFormData",
          Arguments: { file: null },
          FileFormName: 'file',
          URL: "$json:url$/view",
          DeletionURL: "$json:delete_url$"
        });
      } else {
        obj = Object.assign({}, base, {
          Body: "Binary",
          FileFormName: "",
          URL: "$json:url$/view",
          DeletionURL: "$json:delete_url$"
        });
      }

      res.setHeader('Content-disposition', `attachment; filename=ShareX-${mode}.sxcu`);
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify(obj, null, 2));
    }

    app.get('/api/generate-sxcu', handleGenerateSxcu);
    app.post('/api/generate-sxcu', handleGenerateSxcu);

    // Fallback: serve login/dashboard pages
    app.use((req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/upload') || req.path.startsWith('/i')) {
        return jsonError(res, 404, 'Not found');
      }
      const username = checkAuthFromReq(req);
      if (username) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
      return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    });

    // Global error handler
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      if (res.headersSent) return next(err);
      return jsonError(res, 500, 'Internal server error');
    });

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`Server pornit: http://localhost:${PORT}`);
      console.log(`Uploads dir: ${UPLOAD_DIR}`);
      if (initialUploadTokenPlain) {
        console.log('===================================================================');
        console.log('FIRST RUN: a UPLOAD TOKEN was generated automatically (one-time). Copy it now:');
        console.log(initialUploadTokenPlain);
        console.log('===================================================================');
      } else {
        console.log('If you need an upload token, set it via Settings -> Set new Upload Token.');
      }
      if (initialAdminPasswordPlain) {
        console.log('===================================================================');
        console.log('FIRST RUN: default admin created. Username: admin');
        console.log('Password (one-time, copy it now):');
        console.log(initialAdminPasswordPlain);
        console.log('Change it ASAP in Settings.');
        console.log('===================================================================');
      } else {
        console.log('Admin user exists (or was created interactively).');
      }
    });

    // Graceful shutdown
    function graceful(signal) {
      console.log(`Received ${signal}, shutting down...`);
      server.close(() => { console.log('HTTP server closed'); process.exit(0); });
      setTimeout(() => { console.warn('Force exit'); process.exit(1); }, 10000).unref();
    }
    process.on('SIGINT', () => graceful('SIGINT'));
    process.on('SIGTERM', () => graceful('SIGTERM'));

  } catch (err) {
    console.error('Init error:', err);
    process.exit(1);
  }
}

// helper to escape HTML attributes
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// run init
init();
