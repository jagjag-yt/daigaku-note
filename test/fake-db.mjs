// js/db.js(IndexedDB)の代わり。js/webdav.js を Node で動かすテスト(test/server-sync.test.mjs)で使う。
// 端末ごとに別の中身を持たせるため、読み込むときの ?dev=… ごとに別のものになる(test/webdav-hooks.mjs)。
// IndexedDB と同じく、しまうときと取り出すときに複製する(呼んだ側があとで書き換えても、しまったものは変わらない)。
const meta = new Map();
const ops = new Map(); // id → op
const files = new Map(); // hash → { hash, name, type, data: Blob }
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export async function getMeta(key) { return clone(meta.get(key)); }
export async function setMeta(key, value) { meta.set(key, clone(value)); }
// すでにある op(同じ id)は飛ばし、足せた数を返す
export async function putOps(list, clock) {
  let added = 0;
  for (const op of list) if (!ops.has(op.id)) { ops.set(op.id, clone(op)); added++; }
  if (clock) meta.set('clock', clone(clock));
  return added;
}
export async function allOps() { return [...ops.values()].map(clone); }
export async function opsForNote(n) { return [...ops.values()].filter((o) => o.n === n).map(clone); }
export async function opsByDevice(d) { return [...ops.values()].filter((o) => o.d === d).map(clone); }
export async function putFile(f) { files.set(f.hash, { ...f }); }
export async function getFile(hash) { const f = files.get(hash); return f ? { ...f } : undefined; }
export async function hasFile(hash) { return files.has(hash); }
