// IndexedDB への保存。op は追記するだけで、書き換えない。
import { NOTE_TYPES } from './model.js';

const DB_NAME = 'daigaku-note';
const VERSION = 2;
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (ev.oldVersion < 1) {
        const ops = db.createObjectStore('ops', { keyPath: 'id' });
        ops.createIndex('n', 'n');
        ops.createIndex('t', 't');
        db.createObjectStore('meta');
        db.createObjectStore('files', { keyPath: 'hash' });
        db.createObjectStore('notemeta', { keyPath: 'id' });
      }
      if (ev.oldVersion < 2) {
        r.transaction.objectStore('ops').createIndex('d', 'd');
        // 検索用の文字(手書き認識・PDF の文字)。端末ごとに作り直せるので同期しない
        db.createObjectStore('search', { keyPath: 'key' });
      }
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
    // 名前・表紙の変更では並び順(最終更新)を変えない。一覧で操作した直後にカードが入れ替わらないように
    if (op.t === 'note.rename' || op.t === 'note.cover') continue;
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

export async function opsByDevice(device) {
  const db = await openDB();
  return req(db.transaction('ops').objectStore('ops').index('d').getAll(device));
}

export async function putSearch(rec) {
  const db = await openDB();
  const tx = db.transaction('search', 'readwrite');
  tx.objectStore('search').put(rec);
  return done(tx);
}
export async function getSearch(key) {
  const db = await openDB();
  return req(db.transaction('search').objectStore('search').get(key));
}
export async function allSearch() {
  const db = await openDB();
  return req(db.transaction('search').objectStore('search').getAll());
}
