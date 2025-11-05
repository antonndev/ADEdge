// server.js
'use strict';

/**
 * server.js - per-user images + ShareX email binding + HTTP+HTTPS
 *
 * Ce face varianta asta:
 * - tot ce aveai deja (users per-image, upload, ShareX, dashboard, delete by filename etc.)
 * - suport pentru 2 porturi:
 *    - HTTP  (PORT)
 *    - HTTPS (PORT_HTTPS) cu certificat din .env
 *
 * IMPORTANT:
 *  În .env trebuie să ai și:
 *    PORT=80
 *    PORT_HTTPS=443
 *    SSL_KEY_PATH=/cale/la/privkey.pem
 *    SSL_CERT_PATH=/cale/la/fullchain.pem
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const http = require('http');
const https = require('https');

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
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DASHBOARD_HTML_PATH = path.join(PUBLIC_DIR, 'dashboard.html');

// settings.json (pentru lock register)
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  PORT: 3000,
  PORT_HTTPS: 443,
  UPLOAD_DIR: 'uploads',
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  RATE_LIMIT_TOKENS: 20,
  RATE_LIMIT_REFILL: 1
};

const DEFAULT_BACKGROUND = { type: 'color', value: '#05080f' };
const TEMPLATE_BACKGROUNDS = [
  'https://images.unsplash.com/photo-1526481280695-3c469be254d2?auto=format&fit=crop&w=1600&q=80',
  'https://cdn.wallpapersafari.com/72/26/fVpc1S.jpg',
  'https://i.imgur.com/bLxcjh3.png',
  'https://wallpapercave.com/wp/wp4511654.jpg'
];

// în memorie doar prima dată
let initialUploadTokenPlain = null;
let initialAdminPasswordPlain = null;

// lock pentru /register
let registerBlocked = false;

// utils
function randHex(len = 32) { return crypto.randomBytes(len).toString('hex'); }

// ===================== ENV bootstrap =====================
// asta are grijă să NU-ȚI RUPĂ variabilele extra din .env (PORT_HTTPS, SSL_KEY_PATH etc)
function ensureEnv() {
  // dacă .env există deja
  if (fs.existsSync(ENV_PATH)) {
    require('dotenv').config();
    let changed = false;
    const kv = Object.assign({}, process.env);

    if (!kv.UPLOAD_TOKEN_HASH) {
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

    // dacă lipsesc cheile pentru https, le punem dacă e nevoie
    if (!kv.PORT_HTTPS) {
      kv.PORT_HTTPS = DEFAULTS.PORT_HTTPS;
      changed = true;
    }
    if (typeof kv.SSL_KEY_PATH === 'undefined') {
      kv.SSL_KEY_PATH = '';
      changed = true;
    }
    if (typeof kv.SSL_CERT_PATH === 'undefined') {
      kv.SSL_CERT_PATH = '';
      changed = true;
    }

    if (changed) {
      const header = '# Auto-generated .env - do not commit to git';
      const content = [
        header,
        `PORT=${kv.PORT || DEFAULTS.PORT}`,
        `PORT_HTTPS=${kv.PORT_HTTPS || DEFAULTS.PORT_HTTPS}`,
        `UPLOAD_DIR=${kv.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
        `MAX_UPLOAD_BYTES=${kv.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
        `RATE_LIMIT_TOKENS=${kv.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
        `RATE_LIMIT_REFILL=${kv.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
        `SESSION_SECRET=${kv.SESSION_SECRET}`,
        `UPLOAD_TOKEN_HASH=${kv.UPLOAD_TOKEN_HASH}`,
        `SSL_KEY_PATH=${kv.SSL_KEY_PATH || ''}`,
        `SSL_CERT_PATH=${kv.SSL_CERT_PATH || ''}`
      ].join('\n') + '\n';

      fs.writeFileSync(ENV_PATH, content, 'utf8');
      require('dotenv').config();
    }
    return false;
  }

  // .env nu există -> îl creăm acum prima dată
  const uploadTokenPlain = randHex(24);
  const uploadTokenHash = bcrypt.hashSync(uploadTokenPlain, 10);
  const sessionSecret = randHex(32);

  const content = [
    '# Auto-generated .env - do not commit to git',
    `PORT=${process.env.PORT || DEFAULTS.PORT}`,
    `PORT_HTTPS=${process.env.PORT_HTTPS || DEFAULTS.PORT_HTTPS}`,
    `UPLOAD_DIR=${process.env.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
    `MAX_UPLOAD_BYTES=${process.env.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
    `RATE_LIMIT_TOKENS=${process.env.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
    `RATE_LIMIT_REFILL=${process.env.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
    `SESSION_SECRET=${sessionSecret}`,
    `UPLOAD_TOKEN_HASH=${uploadTokenHash}`,
    `SSL_KEY_PATH=${process.env.SSL_KEY_PATH || ''}`,
    `SSL_CERT_PATH=${process.env.SSL_CERT_PATH || ''}`
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  require('dotenv').config();

  initialUploadTokenPlain = uploadTokenPlain;
  return uploadTokenPlain;
}

// prompt hidden pt parola admin prima dată
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const origWrite = rl._writeToOutput;
    rl._writeToOutput = function (stringToWrite) {
      if (rl.stdoutMuted) {
        rl.output.write('*');
      } else {
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

// ===================== helperi user =====================

// bootstrap users.json, asigurăm `images: []` și preferințe
async function ensureDataAndAdminSync() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // dacă există users.json cu minim 1 user
  if (fs.existsSync(USERS_FILE)) {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      if (Array.isArray(parsed.users) && parsed.users.length > 0) {
        // forțăm images[] + background
        let mutated = false;
        for (const u of parsed.users) {
          if (!u.preferences || !u.preferences.background) {
            u.preferences = u.preferences || {};
            u.preferences.background = Object.assign({}, DEFAULT_BACKGROUND);
            mutated = true;
          }
          if (!Array.isArray(u.images)) {
            u.images = [];
            mutated = true;
          }
        }
        if (mutated) {
          fs.writeFileSync(USERS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
        }
        return null;
      }
    } catch (e) {
      // corupt -> mergem mai departe și creăm admin
    }
  }

  // nu avem useri -> creăm admin
  const username = 'admin';
  let adminPassPlain = null;

  if (process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write('\nNo users found. Creating default admin user.\n');
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
    role: 'admin',
    preferences: { background: Object.assign({}, DEFAULT_BACKGROUND) },
    images: [] // <- IMPORTANT, fiecare user are propriile imagini
  };

  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [defaultUser] }, null, 2), 'utf8');
  return adminPassPlain;
}

// găsește user după email (case-insensitive)
function findUserByEmail(emailCandidate) {
  if (!emailCandidate) return null;
  const lower = String(emailCandidate).trim().toLowerCase();
  if (!lower) return null;
  const all = listUsers();
  for (const u of all) {
    if (u && u.email && u.email.toLowerCase() === lower) {
      return u;
    }
  }
  return null;
}

// ===================== settings.json bootstrap pentru register lock =====================
function ensureSettingsFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SETTINGS_FILE)) {
      const defaults = { registerBlocked: false };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
      registerBlocked = defaults.registerBlocked;
      return;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}';
    const json = JSON.parse(raw);
    registerBlocked = !!json.registerBlocked;
  } catch (err) {
    console.error('Failed to init settings.json, defaulting registerBlocked=false', err);
    registerBlocked = false;
  }
}
function saveSettings() {
  try {
    const obj = { registerBlocked: !!registerBlocked };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings.json', err);
  }
}
function getRegisterBlocked() {
  return !!registerBlocked;
}
function setRegisterBlocked(val) {
  registerBlocked = !!val;
  saveSettings();
}

// ===================== helpers env update =====================
// (actualizat ca să menținem PORT_HTTPS și SSL_* când se schimbă tokenul)
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
  kv.PORT_HTTPS = kv.PORT_HTTPS || DEFAULTS.PORT_HTTPS;
  kv.SSL_KEY_PATH = kv.SSL_KEY_PATH || '';
  kv.SSL_CERT_PATH = kv.SSL_CERT_PATH || '';

  const header = '# Auto-generated .env - do not commit to git';
  const content = [
    header,
    `PORT=${kv.PORT || DEFAULTS.PORT}`,
    `PORT_HTTPS=${kv.PORT_HTTPS}`,
    `UPLOAD_DIR=${kv.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR}`,
    `MAX_UPLOAD_BYTES=${kv.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES}`,
    `RATE_LIMIT_TOKENS=${kv.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS}`,
    `RATE_LIMIT_REFILL=${kv.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL}`,
    `SESSION_SECRET=${kv.SESSION_SECRET}`,
    `UPLOAD_TOKEN_HASH=${kv.UPLOAD_TOKEN_HASH}`,
    `SSL_KEY_PATH=${kv.SSL_KEY_PATH}`,
    `SSL_CERT_PATH=${kv.SSL_CERT_PATH}`
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  process.env.UPLOAD_TOKEN_HASH = kv.UPLOAD_TOKEN_HASH;
}

// ===================== helperi IMAGINI PER USER =====================

// adaugă obiect imagine în user.images
function addImageRecordForUser(username, imgObj) {
  const user = findUser(username);
  if (!user) return false;
  const arr = Array.isArray(user.images) ? [...user.images] : [];
  arr.push(imgObj);
  return updateUser(username, { images: arr });
}

// scoate imaginea din user.images după id
function removeImageRecordForUser(username, imageId) {
  const user = findUser(username);
  if (!user) return false;
  const arr = Array.isArray(user.images)
    ? user.images.filter(i => i && i.id !== imageId)
    : [];
  return updateUser(username, { images: arr });
}

// ===================== init + server start =====================
async function init() {
  try {
    const maybeToken = ensureEnv();
    await ensureDataAndAdminSync();
    ensureSettingsFile(); // load registerBlocked
    require('dotenv').config();

    // citim env-urile
    const HTTP_PORT = parseInt(process.env.PORT || DEFAULTS.PORT, 10);
    const HTTPS_PORT = parseInt(process.env.PORT_HTTPS || DEFAULTS.PORT_HTTPS, 10);

    const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || DEFAULTS.UPLOAD_DIR);
    const BACKGROUND_DIR = path.join(UPLOAD_DIR, 'backgrounds');
    const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || DEFAULTS.MAX_UPLOAD_BYTES, 10);
    const RATE_LIMIT_TOKENS = parseInt(process.env.RATE_LIMIT_TOKENS || DEFAULTS.RATE_LIMIT_TOKENS, 10);
    const RATE_LIMIT_REFILL = parseFloat(process.env.RATE_LIMIT_REFILL || DEFAULTS.RATE_LIMIT_REFILL, 10);
    let UPLOAD_TOKEN_HASH = (process.env.UPLOAD_TOKEN_HASH || '').trim();
    const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();

    const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
    const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';

    if (!UPLOAD_TOKEN_HASH || !SESSION_SECRET) {
      console.error('UPLOAD_TOKEN_HASH or SESSION_SECRET missing in .env. Aborting.');
      process.exit(1);
    }

    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    if (!fs.existsSync(BACKGROUND_DIR)) fs.mkdirSync(BACKGROUND_DIR, { recursive: true });

    // multer config pentru imagini normale
    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const safe = (file.originalname || 'file')
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${uuidv4()}-${safe}`);
      }
    });
    const fileFilter = (req, file, cb) => {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image/* allowed'));
      }
      cb(null, true);
    };
    const upload = multer({
      storage,
      fileFilter,
      limits: { fileSize: MAX_UPLOAD_BYTES }
    });

    // multer pentru background-uri custom
    const backgroundStorage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, BACKGROUND_DIR),
      filename: (req, file, cb) => {
        const safe = (file.originalname || 'background')
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${Date.now()}-${uuidv4()}-${safe}`);
      }
    });
    const backgroundUpload = multer({
      storage: backgroundStorage,
      fileFilter,
      limits: { fileSize: 5 * 1024 * 1024 }
    });

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());

    // ===================== PUBLIC ROUTES (register) =====================
    app.get('/register.html', (req, res) => res.sendStatus(404));

    app.get('/register', (req, res) => {
      if (getRegisterBlocked()) return res.sendStatus(403);
      return res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
    });

    // static public files
    app.use(express.static(PUBLIC_DIR, { maxAge: '1d' }));
    app.use('/public', express.static(PUBLIC_DIR, { maxAge: '1d' }));
    app.use('/backgrounds', express.static(BACKGROUND_DIR, { maxAge: '7d' }));

    // ===================== RATE LIMIT (upload public token) =====================
    const rateBuckets = new Map();
    function allowRate(ip) {
      let b = rateBuckets.get(ip);
      const now = Date.now() / 1000;
      if (!b) {
        b = { tokens: DEFAULTS.RATE_LIMIT_TOKENS, last: now };
        rateBuckets.set(ip, b);
      }
      const elapsed = Math.max(0, now - b.last);
      b.tokens = Math.min(
        DEFAULTS.RATE_LIMIT_TOKENS,
        b.tokens + elapsed * DEFAULTS.RATE_LIMIT_REFILL
      );
      b.last = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return true;
      }
      return false;
    }

    // ===================== SESSIUNE CUSTOM =====================
    function signSession(username, ts) {
      const payload = `${username}.${ts}`;
      const hmac = crypto.createHmac('sha256', SESSION_SECRET)
        .update(payload)
        .digest('hex');
      return `${payload}.${hmac}`;
    }

    function verifySessionCookie(cookieValue) {
      if (!cookieValue) return null;
      const parts = cookieValue.split('.');
      if (parts.length < 3) return null;
      const providedHmac = parts.pop();
      const ts = parts.pop();
      const username = parts.join('.');
      const expected = crypto.createHmac('sha256', SESSION_SECRET)
        .update(`${username}.${ts}`)
        .digest('hex');
      try {
        if (!crypto.timingSafeEqual(
          Buffer.from(expected, 'hex'),
          Buffer.from(providedHmac, 'hex')
        )) return null;
      } catch (e) {
        return null;
      }
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

    // ===================== UPLOAD TOKEN VALIDARE =====================
    function verifyUploadToken(candidate) {
      if (!candidate) return false;
      // acceptăm tokenul generat la boot (prima dată) sau orice token care matchează hashul
      if (initialUploadTokenPlain && candidate === initialUploadTokenPlain) return true;
      try {
        return bcrypt.compareSync(candidate, UPLOAD_TOKEN_HASH);
      } catch (e) {
        return false;
      }
    }

    function persistNewUploadTokenHash(newHash) {
      setUploadTokenHashInEnv(newHash);
      UPLOAD_TOKEN_HASH = newHash;
    }

    // common helpers
    function getOrigin(req) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.headers['host'];
      return `${proto}://${host}`;
    }
    function jsonError(res, status = 400, msg = 'error') {
      return res.status(status).json({ success: false, error: msg });
    }

    // ===================== BACKGROUND PREFERENCES =====================
    function normalizeBackgroundPref(pref) {
      if (!pref || typeof pref !== 'object') {
        return Object.assign({}, DEFAULT_BACKGROUND);
      }
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
      return normalizeBackgroundPref(
        user && user.preferences && user.preferences.background || DEFAULT_BACKGROUND
      );
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

    function escapeCssUrl(value) {
      return String(value || '').replace(/'/g, "\\'");
    }

    async function rewriteDashboardBackground(pref) {
      if (!pref) return;
      try {
        const html = await fsp.readFile(DASHBOARD_HTML_PATH, 'utf8');
        let next = html;

        // încercăm să prindem niște CSS inline (best effort)
        const varPattern = /(--bg:\s*)([^;]+)(;)/;
        const bodyPattern = /(body\s*\{[^}]*?background:\s*)([^;]+)(;)/;

        const colorValue = pref.type === 'color'
          ? pref.value
          : DEFAULT_BACKGROUND.value;

        const backgroundValue = pref.type === 'color'
          ? pref.value
          : `url('${escapeCssUrl(pref.value)}') center/cover no-repeat fixed`;

        if (varPattern.test(next)) {
          next = next.replace(varPattern, `$1${colorValue}$3`);
        }

        if (bodyPattern.test(next)) {
          next = next.replace(bodyPattern, `$1${backgroundValue}$3`);
        }

        if (next !== html) {
          await fsp.writeFile(DASHBOARD_HTML_PATH, next, 'utf8');
        }
      } catch (err) {
        console.error('Failed to rewrite dashboard background', err);
      }
    }

    // ce trimitem la client ca profil
    function userForClient(user) {
      if (!user) return null;
      return {
        username: user.username,
        email: user.email || '',
        created_at: user.created_at,
        role: user.role || (user.username === 'admin' ? 'admin' : 'user'),
        backgroundPreference: getBackgroundPreference(user)
        // nu trimitem lista de imagini aici; dashboard le ia din /api/images
      };
    }

    // ===================== BASIC PAGES =====================
    app.get('/', (req, res) => {
      try {
        const username = checkAuthFromReq(req);
        if (username) return res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
        return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
      } catch (err) {
        console.error('Error serving /', err);
        return jsonError(res, 500, 'Internal server error');
      }
    });

    app.get('/settings', (req, res) => {
      try {
        const username = checkAuthFromReq(req);
        if (!username) return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
        return res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
      } catch (err) {
        console.error('Error serving /settings', err);
        return jsonError(res, 500, 'Internal server error');
      }
    });

    app.get('/healthz', (req, res) => res.json({ ok: true }));

    // ===================== PUBLIC IMAGE VIEW / OG =====================
    app.get('/i/:filename/view', async (req, res) => {
      try {
        const filename = req.params.filename;
        const filePath = path.join(UPLOAD_DIR, filename);
        if (path.relative(UPLOAD_DIR, filePath).startsWith('..')) {
          return jsonError(res, 400, 'Invalid filename');
        }
        await fsp.access(filePath, fs.constants.R_OK);
        const origin = getOrigin(req);
        const imageUrl = `${origin}/i/${encodeURIComponent(filename)}`;
        const pageUrl = `${origin}/i/${encodeURIComponent(filename)}/view`;
        const imageTitle = path.basename(filename);

        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Image view</title>
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

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.status(200).send(html);
      } catch (err) {
        return jsonError(res, 404, 'Not found');
      }
    });

    app.get('/i/:filename', async (req, res) => {
      try {
        const filename = req.params.filename;
        const filePath = path.join(UPLOAD_DIR, filename);
        if (path.relative(UPLOAD_DIR, filePath).startsWith('..')) {
          return jsonError(res, 400, 'Invalid filename');
        }
        await fsp.access(filePath, fs.constants.R_OK);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.sendFile(filePath);
      } catch (err) {
        return jsonError(res, 404, 'Not found');
      }
    });

    // helper intern: construiește metadatele imaginii și le atașează la user (dacă există)
    async function finalizeUploadAndRespond(req, res, originalName, sizeBytes, filename) {
      try {
        const origin = getOrigin(req);
        const url = `${origin}/i/${encodeURIComponent(filename)}`;
        const id = uuidv4();

        // aflăm userul eventual, din headerul ShareX
        const emailHeader = req.headers['x-user-email'] || req.headers['x-useremail'] || req.headers['x-user_email'] || '';
        const ownerUser = findUserByEmail(emailHeader);

        const meta = {
          id,
          filename,
          originalname: originalName,
          size: sizeBytes,
          url,
          uploaded_at: Date.now(),
          owner: ownerUser ? ownerUser.username : null
        };

        // adăugăm în images global
        addImage(meta);

        // dacă am găsit user după email, îi adăugăm poza la user.images
        if (ownerUser && ownerUser.username) {
          addImageRecordForUser(ownerUser.username, meta);
        }

        return res.json({
          success: true,
          url,
          delete_url: `${origin}/api/images/${id}`
        });
      } catch (err) {
        console.error('finalizeUploadAndRespond error:', err);
        return jsonError(res, 500, 'Internal server error');
      }
    }

    // ===================== PUBLIC /upload (ShareX token) =====================
    // Upload folosit de ShareX: Authorization Bearer <token> + X-User-Email <email-ul-userului>
    // Ca să știm cui să atribuim poza.
    app.post('/upload', async (req, res) => {
      try {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        if (!allowRate(ip)) return jsonError(res, 429, 'Too many requests');

        const auth = (req.headers['authorization'] || '');
        if (!auth.startsWith('Bearer ')) {
          return jsonError(res, 401, 'Missing Authorization header');
        }
        const tokenCandidate = auth.slice(7).trim();
        if (!verifyUploadToken(tokenCandidate)) {
          return jsonError(res, 401, 'Invalid upload token');
        }

        const contentType = (req.headers['content-type'] || '').toLowerCase();

        // multipart/form-data (ShareX FileFormName=file)
        if (contentType.startsWith('multipart/form-data')) {
          return upload.single('file')(req, res, async function (err) {
            if (err) {
              console.error('multer error:', err);
              return jsonError(res, 400, err.message || 'Upload error');
            }
            if (!req.file) return jsonError(res, 400, 'No file provided (field name: file)');

            // finalize => bagă meta în DB global și în user.images (după email header)
            return finalizeUploadAndRespond(
              req,
              res,
              req.file.originalname,
              req.file.size,
              req.file.filename
            );
          });
        }

        // raw/binary
        const maxBytes = MAX_UPLOAD_BYTES;
        let totalBytes = 0;
        const filenameHeader = req.headers['x-filename'] || `${Date.now()}.png`;
        const safe = String(filenameHeader)
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
          try { await fsp.unlink(filepath); } catch (_) {}
          console.error('Binary upload failed:', err.message || err);
          return jsonError(
            res,
            err.message === 'File too large' ? 413 : 400,
            err.message || 'Upload error'
          );
        }

        return finalizeUploadAndRespond(
          req,
          res,
          filenameHeader,
          totalBytes,
          filename
        );
      } catch (err) {
        console.error('Unexpected upload error:', err);
        return jsonError(res, 500, 'Internal server error');
      }
    });

    // ===================== LOGIN / LOGOUT =====================
    app.post('/api/login', async (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return jsonError(res, 400, 'username and password required');
      }
      const user = findUser(username);
      if (!user) return jsonError(res, 401, 'Invalid credentials');

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return jsonError(res, 401, 'Invalid credentials');

      const ts = Date.now();
      const cookieVal = signSession(username, ts);
      res.cookie('session', cookieVal, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        secure: (process.env.NODE_ENV === 'production')
      });

      return res.json({
        success: true,
        username: user.username,
        email: user.email
      });
    });

    app.post('/api/logout', (req, res) => {
      res.clearCookie('session');
      return res.json({ success: true });
    });

    // ===================== PUBLIC REGISTER (CREATE ACCOUNT) =====================
    app.post('/registeryouraccount/register', async (req, res) => {
      try {
        // dacă adminul a blocat înregistrările noi
        if (getRegisterBlocked && getRegisterBlocked()) {
          return res.status(403).json({
            error: 'Registration is currently disabled.'
          });
        }

        const { username, email, password } = req.body || {};

        // validări de bază
        if (
          !username || typeof username !== 'string' || !username.trim() ||
          !email    || typeof email    !== 'string' || !email.trim() ||
          !password || typeof password !== 'string' || !password
        ) {
          return res.status(400).json({
            error: 'Missing username, email or password.'
          });
        }

        const cleanUsername = username.trim();
        const cleanEmail = email.trim();

        if (!/^[a-zA-Z0-9._-]{3,32}$/.test(cleanUsername)) {
          return res.status(400).json({
            error: 'Username must be 3-32 chars (letters / numbers / . _ - ).'
          });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanEmail)) {
          return res.status(400).json({
            error: 'Invalid email format.'
          });
        }
        if (password.length < 6) {
          return res.status(400).json({
            error: 'Password must be at least 6 characters.'
          });
        }

        // verifică dacă există deja username-ul
        const existingUser = findUser(cleanUsername);
        if (existingUser) {
          return res.status(409).json({
            error: 'Username already exists.'
          });
        }

        // verifică dacă emailul e deja luat de alt user
        const allUsers = listUsers();
        const emailTaken = allUsers.some(u =>
          u &&
          u.email &&
          u.email.toLowerCase() === cleanEmail.toLowerCase()
        );
        if (emailTaken) {
          return res.status(409).json({
            error: 'Email already exists.'
          });
        }

        // hash parola
        const password_hash = await bcrypt.hash(password, 10);

        // creează userul nou
        createUser({
          username: cleanUsername,
          email: cleanEmail,
          password_hash,
          created_at: Date.now(),
          role: 'user',
          preferences: { background: Object.assign({}, DEFAULT_BACKGROUND) },
          images: [] // user nou începe cu lista goală
        });

        // răspuns final
        return res.status(201).json({
          ok: true,
          message: 'User created.',
          user: {
            username: cleanUsername,
            email: cleanEmail,
            role: 'user'
          }
        });
      } catch (err) {
        console.error('Public register error:', err);
        return res.status(500).json({
          error: 'Internal server error.'
        });
      }
    });

    // ===================== PROFILE CURRENT USER =====================
    function handleAccountMe(req, res) {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      const user = findUser(username);
      if (!user) return jsonError(res, 404, 'User not found');
      return res.json({ success: true, user: userForClient(user) });
    }
    app.get('/api/me', handleAccountMe);
    app.get('/api/account/me', handleAccountMe);

    // ===================== ACCOUNT SETTINGS (PASSWORD / UPLOAD TOKEN) =====================
    async function handleAccountSettings(req, res) {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');

      const {
        currentPassword,
        newPassword,
        newUploadToken
      } = req.body || {};

      const user = findUser(username);
      if (!user) return jsonError(res, 404, 'User not found');

      // schimbare parolă
      if (newPassword) {
        if (!currentPassword) {
          return jsonError(res, 400, 'currentPassword required to change password');
        }
        const ok = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok) return jsonError(res, 401, 'Current password incorrect');

        if (newPassword.length < 6) {
          return jsonError(res, 400, 'Password must be at least 6 characters');
        }

        const newHash = await bcrypt.hash(newPassword, 10);
        updateUser(username, { password_hash: newHash });
      }

      // schimbare upload token (pt ShareX/public /upload)
      if (newUploadToken) {
        if (!currentPassword) {
          return jsonError(res, 400, 'currentPassword required to change upload token');
        }
        const ok2 = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok2) {
          return jsonError(res, 401, 'Current password incorrect (for upload token change)');
        }
        if (newUploadToken.length < 6) {
          return jsonError(res, 400, 'Upload token must be at least 6 chars');
        }

        const newTokenHash = await bcrypt.hash(newUploadToken, 10);
        persistNewUploadTokenHash(newTokenHash);

        // facem tokenul nou disponibil imediat pentru sesiunea asta
        initialUploadTokenPlain = newUploadToken;
      }

      return res.json({ success: true, message: 'Settings updated' });
    }

    app.post('/api/settings', handleAccountSettings);
    app.post('/api/account/settings', handleAccountSettings);

    // ===================== EMAIL UPDATE =====================
    app.post('/api/account/email', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');

      const newEmailRaw = (req.body && req.body.email || '').trim();
      if (!newEmailRaw) {
        return jsonError(res, 400, 'Email required');
      }

      // format email simplu
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(newEmailRaw)) {
        return jsonError(res, 400, 'Invalid email format');
      }

      const newEmailLower = newEmailRaw.toLowerCase();

      // e deja folosit de alt user?
      const allUsers = listUsers();
      const conflict = allUsers.some(u =>
        u &&
        u.username !== username &&
        u.email &&
        u.email.toLowerCase() === newEmailLower
      );
      if (conflict) {
        return jsonError(res, 409, 'Email already in use');
      }

      // update pentru userul curent
      const ok = updateUser(username, { email: newEmailRaw });
      if (!ok) {
        return jsonError(res, 404, 'User not found');
      }

      return res.json({
        success: true,
        email: newEmailRaw,
        message: 'Email updated'
      });
    });

    // ===================== BACKGROUND (TEMPLATES, ETC) =====================
    app.get('/api/account/background/templates', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      return res.json({
        success: true,
        templates: TEMPLATE_BACKGROUNDS,
        defaultBackground: DEFAULT_BACKGROUND
      });
    });

    // ===================== DELETE IMAGE BY ID (compat / ShareX)
    app.delete('/api/images/:id', async (req, res) => {
      try {
        const username = checkAuthFromReq(req);
        if (!username) return jsonError(res, 401, 'Unauthorized');

        const id = req.params.id;
        if (!id) return jsonError(res, 400, 'No image id');

        // găsim userul
        const user = findUser(username);
        if (!user) return jsonError(res, 404, 'User not found');

        const imgsArr = Array.isArray(user.images) ? user.images : [];
        const item = imgsArr.find(i => i && i.id === id);
        if (!item) {
          return jsonError(res, 404, 'Not found or not owned');
        }

        // ștergem fișierul fizic
        const filepath = path.join(UPLOAD_DIR, item.filename);
        try {
          await fsp.unlink(filepath).catch(() => {});
        } catch (err) {
          console.error('unlink failed:', err);
        }

        // scoatem din DB global
        removeImage(id);

        // scoatem din user.images
        removeImageRecordForUser(username, id);

        return res.json({ success: true });
      } catch (err) {
        console.error('Delete error (by id):', err);
        return jsonError(res, 500, 'Delete failed');
      }
    });

    // ===================== DELETE IMAGE BY FILENAME (dashboard uses this)
    app.delete('/api/images', async (req, res) => {
      try {
        const username = checkAuthFromReq(req);
        if (!username) return jsonError(res, 401, 'Unauthorized');

        const filenameRaw = req.body && req.body.filename;
        if (!filenameRaw) {
          return jsonError(res, 400, 'Missing filename');
        }

        // ne asigurăm că nu e path traversal
        const safeFilename = path.basename(String(filenameRaw));
        const filePath = path.join(UPLOAD_DIR, safeFilename);

        // 1. Șterge fișierul fizic din uploads/
        try {
          if (!path.relative(UPLOAD_DIR, filePath).startsWith('..')) {
            await fsp.unlink(filePath).catch(() => {});
          }
        } catch (err) {
          // dacă nu există deja pe disc, nu e fatal
          console.warn('unlink by filename failed or file missing:', err.message || err);
        }

        // 2. Curăță din images.json global
        const allImages = listImages(); // [{id, filename, ...}, ...]
        const toRemove = allImages.filter(img => img && img.filename === safeFilename);
        for (const imgMeta of toRemove) {
          if (imgMeta && imgMeta.id) {
            removeImage(imgMeta.id);
          }
        }

        // 3. Curăță din fiecare user.images din users.json
        const allUsers = listUsers();
        allUsers.forEach(u => {
          if (!u) return;
          const arr = Array.isArray(u.images) ? u.images : [];
          const cleaned = arr.filter(meta => meta && meta.filename !== safeFilename);
          if (cleaned.length !== arr.length) {
            updateUser(u.username, { images: cleaned });
          }
        });

        // 4. Done.
        return res.json({ success: true });
      } catch (err) {
        console.error('Delete error (by filename):', err);
        return jsonError(res, 500, 'Delete failed');
      }
    });

    // ===================== ADMIN: LIST USERS =====================
    app.get('/api/account/users', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');

      const users = listUsers().map(userForClient);
      return res.json({ success: true, users });
    });

    // ===================== ADMIN: CREATE USER =====================
    app.post('/api/account/users', async (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');

      const { newUsername, email, password } = req.body || {};
      if (!newUsername || !email || !password) {
        return jsonError(res, 400, 'newUsername, email and password required');
      }

      const trimmedUsername = newUsername.trim();
      const trimmedEmail = email.trim();

      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(trimmedUsername)) {
        return jsonError(res, 400, 'Username must be 3-32 characters');
      }
      if (!/^.+@.+\..+$/.test(trimmedEmail)) {
        return jsonError(res, 400, 'Email invalid');
      }
      if (password.length < 6) {
        return jsonError(res, 400, 'Password must be at least 6 characters');
      }

      const existingUser = findUser(trimmedUsername);
      if (existingUser) {
        return jsonError(res, 409, 'Username already exists');
      }

      const emailTaken = listUsers().some(u =>
        (u.email || '').toLowerCase() === trimmedEmail.toLowerCase()
      );
      if (emailTaken) {
        return jsonError(res, 409, 'Email already exists');
      }

      const hashed = await bcrypt.hash(password, 10);

      createUser({
        username: trimmedUsername,
        email: trimmedEmail,
        password_hash: hashed,
        created_at: Date.now(),
        role: 'user',
        preferences: { background: Object.assign({}, DEFAULT_BACKGROUND) },
        images: [] // noul user începe cu 0 poze
      });

      return res.json({
        success: true,
        user: userForClient(findUser(trimmedUsername))
      });
    });

    // ===================== ADMIN: DELETE USER =====================
    app.delete('/api/account/users/:username', (req, res) => {
      const actor = checkAuthFromReq(req);
      if (!actor) return jsonError(res, 401, 'Unauthorized');
      if (actor !== 'admin') return jsonError(res, 403, 'Admin access required');

      const target = req.params.username;
      if (!target) return jsonError(res, 400, 'username required');
      if (target === 'admin') {
        return jsonError(res, 400, 'Cannot delete admin account');
      }

      const ok = deleteUser(target);
      if (!ok) return jsonError(res, 404, 'User not found');
      return res.json({ success: true });
    });

    // ===================== LOGGED-IN UPLOAD (dashboard form) =====================
    // Upload cu sesiune cookie: știm userul din cookie, deci atribuim direct
    app.get('/api/images', (req, res) => {
      // Returnăm DOAR pozele userului curent, din users.json
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');

      const user = findUser(username);
      if (!user) return jsonError(res, 404, 'User not found');

      const imgs = Array.isArray(user.images) ? user.images : [];
      return res.json({ success: true, images: imgs });
    });

    app.post('/api/upload', (req, res) => {
      // Upload manual din dashboard (cu sesiune cookie, nu ShareX)
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');

      return upload.single('file')(req, res, function (err) {
        if (err) {
          console.error('multer api/upload err', err);
          return jsonError(res, 400, err.message || 'Upload error');
        }
        if (!req.file) return jsonError(res, 400, 'No file');

        const filename = req.file.filename;
        const origin = getOrigin(req);
        const url = `${origin}/i/${encodeURIComponent(filename)}`;
        const id = uuidv4();
        const meta = {
          id,
          filename,
          originalname: req.file.originalname,
          size: req.file.size,
          url,
          uploaded_at: Date.now(),
          owner: username
        };

        // scriem în DB global imagini
        addImage(meta);

        // atașăm imaginea la userul curent în users.json
        addImageRecordForUser(username, meta);

        return res.json({ success: true, url });
      });
    });

    // ===================== ADMIN: REGISTER LOCK =====================
    app.get('/api/admin/register', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');

      return res.json({ blocked: getRegisterBlocked() });
    });

    app.post('/api/admin/register', (req, res) => {
      const username = checkAuthFromReq(req);
      if (!username) return jsonError(res, 401, 'Unauthorized');
      if (username !== 'admin') return jsonError(res, 403, 'Admin access required');

      const { blocked } = req.body || {};
      const val = blocked === true || blocked === 'true';
      setRegisterBlocked(val);
      return res.json({ success: true, blocked: getRegisterBlocked() });
    });

    // ===================== GENERATE SHAREX PROFILE =====================
    // IMPORTANT: includem și emailul userului curent în headerul X-User-Email
    function handleGenerateSxcu(req, res) {
      const username = checkAuthFromReq(req);
      if (username === null) return jsonError(res, 401, 'Unauthorized');

      const origin = getOrigin(req);

      // userul curent, pt email (match cu upload / X-User-Email)
      const user = findUser(username);
      const userEmail = (user && user.email) ? user.email : '';

      // token pt ShareX:
      // - dacă avem încă plaintext-ul generat la boot, îl folosim
      // - altfel generăm unul fresh + îl hash-uim în .env
      let token;
      if (initialUploadTokenPlain) {
        token = initialUploadTokenPlain;
      } else if (process.env.UPLOAD_TOKEN_HASH) {
        token = randHex(24);
        const newHash = bcrypt.hashSync(token, 10);
        persistNewUploadTokenHash(newHash);
        initialUploadTokenPlain = token;
        console.log(`[INFO] Generated new upload token for ShareX: ${token}`);
      } else {
        return jsonError(res, 500, 'No upload token available');
      }

      // Headers pe care ShareX le va trimite la fiecare upload
      // => serverul va putea mapa screenshotul la user prin X-User-Email
      const headers = {
        Authorization: `Bearer ${token}`,
        'X-User-Email': userEmail
      };

      // config ShareX stabil (MultipartFormData only)
      // - fără Arguments null
      // - folosim {json:...} în loc de $json:...$
      // - versiune mai nouă
      const sxcu = {
        Version: "17.0.0",
        Name: `ADEdge uploader (${origin})`,
        DestinationType: "ImageUploader, TextUploader, FileUploader",
        RequestMethod: "POST",
        RequestURL: `${origin}/upload`,
        Headers: headers,
        Body: "MultipartFormData",
        FileFormName: "file",
        URL: "{json:url}/view",
        DeletionURL: "{json:delete_url}"
        // Dacă vrei și mesaj de eroare ShareX:
        // ErrorMessage: "{json:error}"
      };

      res.setHeader('Content-disposition', 'attachment; filename=ADEdge.sxcu');
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify(sxcu, null, 2));
    }

    app.get('/api/generate-sxcu', handleGenerateSxcu);
    app.post('/api/generate-sxcu', handleGenerateSxcu);

    // ===================== FALLBACK ROUTE =====================
    app.use((req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/upload') ||
        req.path.startsWith('/i')
      ) {
        return jsonError(res, 404, 'Not found');
      }

      // dacă ești logat -> dashboard, altfel -> login
      const username = checkAuthFromReq(req);
      if (username) {
        return res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
      }
      return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    });

    // ===================== GLOBAL ERROR HANDLER =====================
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      if (res.headersSent) return next(err);
      return jsonError(res, 500, 'Internal server error');
    });

    // ===================== START HTTP + HTTPS =====================
    // Server HTTP
    const httpServer = http.createServer(app);
    httpServer.listen(HTTP_PORT, () => {
      console.log(`HTTP server pornit:  http://localhost:${HTTP_PORT}`);
    });
    httpServer.on('error', (err) => {
      console.error('HTTP error:', err.message || err);
    });

    // Server HTTPS (doar dacă avem key+cert și port definit)
    let httpsServer = null;
    if (SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
      try {
        const httpsOptions = {
          key: fs.readFileSync(SSL_KEY_PATH),
          cert: fs.readFileSync(SSL_CERT_PATH)
        };
        httpsServer = https.createServer(httpsOptions, app);
        httpsServer.listen(HTTPS_PORT, () => {
          console.log(`HTTPS server pornit: https://localhost:${HTTPS_PORT}`);
        });
        // asta e ce îți lipsea ca să vezi de ce NU pornește 443
        httpsServer.on('error', (err) => {
          console.error('HTTPS error:', err.message || err);
        });
      } catch (err) {
        console.error('Nu am putut porni HTTPS:', err.message || err);
      }
    } else {
      console.log('HTTPS NU a pornit (SSL_KEY_PATH / SSL_CERT_PATH lipsesc sau nu există pe disc).');
      console.log('SSL_KEY_PATH =', SSL_KEY_PATH);
      console.log('SSL_CERT_PATH =', SSL_CERT_PATH);
    }

    console.log(`Uploads dir: ${UPLOAD_DIR}`);
    console.log(`Registration lock: ${getRegisterBlocked() ? 'BLOCKED' : 'OPEN'}`);

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

    // graceful shutdown
    function graceful(signal) {
      console.log(`Received ${signal}, shutting down...`);

      httpServer.close(() => {
        console.log('HTTP server closed');
        if (httpsServer) {
          httpsServer.close(() => {
            console.log('HTTPS server closed');
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      });

      setTimeout(() => {
        console.warn('Force exit');
        process.exit(1);
      }, 10000).unref();
    }
    process.on('SIGINT', () => graceful('SIGINT'));
    process.on('SIGTERM', () => graceful('SIGTERM'));

  } catch (err) {
    console.error('Init error:', err);
    process.exit(1);
  }
}

// escapeHtml folosit la OG card
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

init();
