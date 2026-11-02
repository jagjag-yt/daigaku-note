// IndexedDB への保存。op は追記するだけで、書き換えない。
import { NOTE_TYPES } from './model.js';

const DB_NAME = 'daigaku-note';
const VERSION = 1;
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const ops = db.createObjectStore('ops', { keyPath: 'id' });
      ops.createIndex('n', 'n');
      ops.createIndex('t', 't');
      db.createObjectStore('meta');
      db.createObjectStore('files', { keyPath: 'hash' });
      db.createObjectStore('notemeta', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });

export async function getMeta(key) {
  const db = await openDB();
  return req(db.transaction('meta').objectStore('meta').get(key));
}
export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return done(tx);
}

// op を追加する。すでにある op(同じ id)は飛ばす。追加できた数を返す。
export async function putOps(ops, clock) {
  const db = await openDB();
  const tx = db.transaction(['ops', 'notemeta', 'meta'], 'readwrite');
  const store = tx.objectStore('ops');
  const nm = tx.objectStore('notemeta');
  let added = 0;
  const latest = new Map();
  for (const op of ops) {
    const r = store.add(op);
    r.onsuccess = () => { added++; };
    r.onerror = (e) => { e.preventDefault(); e.stopPropagation(); }; // 既にある
    latest.set(op.n, Math.max(latest.get(op.n) || 0, op.ts || 0));
  }
  for (const [id, ts] of latest) {
    const g = nm.get(id);
    g.onsuccess = () => {
      const cur = g.result;
      if (!cur || cur.updatedAt < ts) nm.put({ id, updatedAt: ts });
    };
  }
  if (clock) tx.objectStore('meta').put(clock, 'clock');
  await done(tx);
  return added;
}

export async function opsForNote(noteId) {
  const db = await openDB();
  return req(db.transaction('ops').objectStore('ops').index('n').getAll(noteId));
}

export async function noteLevelOps() {
  const db = await openDB();
  const idx = db.transaction('ops').objectStore('ops').index('t');
  const lists = await Promise.all(NOTE_TYPES.map((t) => req(idx.getAll(t))));
  return lists.flat();
}

export async function allOps() {
  const db = await openDB();
  return req(db.transaction('ops').objectStore('ops').getAll());
}

export async function allNoteMeta() {
  const db = await openDB();
  return req(db.transaction('notemeta').objectStore('notemeta').getAll());
}

export async function putFile(file) {
  const db = await openDB();
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').put(file);
  return done(tx);
}
export async function getFile(hash) {
  const db = await openDB();
  return req(db.transaction('files').objectStore('files').get(hash));
}
export async function hasFile(hash) {
  const db = await openDB();
  const k = await req(db.transaction('files').objectStore('files').getKey(hash));
  return k !== undefined;
}
