'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ensure data dir and initial files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(IMAGES_FILE)) {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify({ images: [] }, null, 2), 'utf8');
}
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
}

// Images functions
function readImages() {
  const raw = fs.readFileSync(IMAGES_FILE, 'utf8');
  return JSON.parse(raw);
}
function writeImages(obj) {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function listImages() {
  const db = readImages();
  return db.images || [];
}
function addImage(entry) {
  const db = readImages();
  db.images.unshift(entry);
  writeImages(db);
}
function removeImage(id) {
  const db = readImages();
  const idx = db.images.findIndex(i => i.id === id);
  if (idx === -1) return false;
  db.images.splice(idx, 1);
  writeImages(db);
  return true;
}

// Users functions
function readUsers() {
  const raw = fs.readFileSync(USERS_FILE, 'utf8');
  return JSON.parse(raw);
}
function writeUsers(obj) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function listUsers() {
  const db = readUsers();
  return db.users || [];
}
function findUser(username) {
  const users = listUsers();
  return users.find(u => u.username === username) || null;
}
function createUser(userObj) {
  const db = readUsers();
  db.users.unshift(userObj);
  writeUsers(db);
}
function updateUser(username, fields) {
  const db = readUsers();
  const idx = db.users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  db.users[idx] = Object.assign({}, db.users[idx], fields);
  writeUsers(db);
  return true;
}
function deleteUser(username) {
  const db = readUsers();
  const next = db.users.filter(u => u.username !== username);
  if (next.length === db.users.length) return false;
  db.users = next;
  writeUsers(db);
  return true;
}

module.exports = {
  DATA_DIR, IMAGES_FILE, USERS_FILE,
  listImages, addImage, removeImage,
  listUsers, findUser, createUser, updateUser, deleteUser
};
