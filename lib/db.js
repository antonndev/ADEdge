'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// asigură-te că există folderul data
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// dacă lipsesc fișierele, le creăm cu structura corectă
if (!fs.existsSync(IMAGES_FILE)) {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify({ images: [] }, null, 2), 'utf8');
}
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
}

// ---------- helpers generale ----------
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : fallback;
  } catch (err) {
    console.warn('readJsonSafe failed for', filePath, err.message || err);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('writeJsonSafe failed for', filePath, err);
  }
}

// ===================================================================
// IMAGES
// ===================================================================
function loadImages() {
  // vrem mereu { images: [] }
  const db = readJsonSafe(IMAGES_FILE, { images: [] });
  if (!Array.isArray(db.images)) {
    db.images = [];
  }
  return db;
}

function saveImages(db) {
  if (!db || !Array.isArray(db.images)) {
    db = { images: [] };
  }
  writeJsonSafe(IMAGES_FILE, db);
}

function listImages() {
  const db = loadImages();
  return db.images;
}

function addImage(entry) {
  const db = loadImages();
  // dacă dintr-un motiv oarecare e undefined, o facem array
  if (!Array.isArray(db.images)) {
    db.images = [];
  }
  db.images.unshift(entry);
  saveImages(db);
  return true;
}

function removeImage(id) {
  const db = loadImages();
  const before = db.images.length;
  db.images = db.images.filter(img => img && img.id !== id);
  const after = db.images.length;
  saveImages(db);
  return after < before;
}

// ===================================================================
// USERS
// ===================================================================
function loadUsers() {
  // vrem mereu { users: [] }
  const db = readJsonSafe(USERS_FILE, { users: [] });
  if (!Array.isArray(db.users)) {
    db.users = [];
  }
  return db;
}

function saveUsers(db) {
  if (!db || !Array.isArray(db.users)) {
    db = { users: [] };
  }
  writeJsonSafe(USERS_FILE, db);
}

function listUsers() {
  const db = loadUsers();
  return db.users;
}

function findUser(username) {
  const users = listUsers();
  return users.find(u => u && u.username === username) || null;
}

function createUser(userObj) {
  const db = loadUsers();
  db.users.unshift(userObj);
  saveUsers(db);
  return true;
}

function updateUser(username, fields) {
  const db = loadUsers();
  const idx = db.users.findIndex(u => u && u.username === username);
  if (idx === -1) return false;

  const oldUser = db.users[idx] || {};
  const nextUser = Object.assign({}, oldUser, fields);

  db.users[idx] = nextUser;
  saveUsers(db);
  return true;
}

function deleteUser(username) {
  const db = loadUsers();
  const next = db.users.filter(u => u && u.username !== username);
  if (next.length === db.users.length) return false;
  db.users = next;
  saveUsers(db);
  return true;
}

// ===================================================================
// EXPORT
// ===================================================================
module.exports = {
  DATA_DIR,
  IMAGES_FILE,
  USERS_FILE,
  listImages,
  addImage,
  removeImage,
  listUsers,
  findUser,
  createUser,
  updateUser,
  deleteUser
};
