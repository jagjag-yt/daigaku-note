// 同期の土台:op と PDF・画像をまとめた「同期ファイル」を書き出し、別の端末で取り込む。
// 取り込みは「まだ持っていない op を足すだけ」なので、何度取り込んでも、どの順で取り込んでも結果は同じ。
// 後で WebDAV や自前サーバーに載せ替えるときも、この形(op の集合の送り合い)をそのまま使う。
import * as db from './db.js';
import { fileRefs } from './model.js';
import { FILE_TYPES, cleanOps, isHash } from './validate.js';

export const FORMAT = 'daigaku-note-sync';

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export async function buildSyncFile(device, noteId = null) {
  const ops = noteId ? await db.opsForNote(noteId) : await db.allOps();
  const hashes = new Set();
  for (const op of ops) for (const r of fileRefs(op)) hashes.add(r.hash);
  const files = [];
  for (const h of hashes) {
    const f = await db.getFile(h);
    if (f) files.push({ hash: f.hash, name: f.name, type: f.type, data: await blobToDataUrl(f.data) });
  }
  ops.sort((a, b) => a.l - b.l || (a.d < b.d ? -1 : 1));
  return { format: FORMAT, version: 1, device, exportedAt: new Date().toISOString(), ops, files };
}

// data: の URL を中身に戻す(fetch を使わない。CSP で data: への通信を許していないため)
function dataUrlBytes(url) {
  const i = url.indexOf(',');
  if (i < 0) return null;
  try {
    if (!/;base64$/i.test(url.slice(0, i))) return new TextEncoder().encode(decodeURIComponent(url.slice(i + 1)));
    const bin = atob(url.slice(i + 1));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function importSyncFile(json, recorder) {
  if (!json || json.format !== FORMAT) throw new Error('大学ノートの同期ファイルではありません');
  if (json.version > 1) throw new Error('新しいバージョンの大学ノートで作られたファイルです。アプリを更新してください');
  let newFiles = 0;
  for (const f of Array.isArray(json.files) ? json.files : []) {
    // 他人のファイルは信用しない: data: の URL だけを読み(ほかの住所へは取りに行かない)、中身がハッシュと合うものだけを入れる
    if (!f || !isHash(f.hash) || typeof f.data !== 'string' || !f.data.startsWith('data:')) continue;
    if (await db.hasFile(f.hash)) continue;
    const type = FILE_TYPES.has(f.type) ? f.type : 'application/octet-stream';
    const buf = dataUrlBytes(f.data);
    if (!buf) continue;
    if ((await sha256Hex(buf)) !== f.hash) continue;
    await db.putFile({ hash: f.hash, name: String(f.name ?? '').slice(0, 200), type, data: new Blob([buf], { type }) });
    newFiles++;
  }
  const ops = cleanOps(json.ops);
  for (const op of ops) recorder.observe(op);
  const added = await db.putOps(ops, recorder.clock);
  const notes = new Set(ops.map((o) => o.n));
  return { added, total: ops.length, newFiles, notes };
}
