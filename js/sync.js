// 同期の土台:op と PDF・画像をまとめた「同期ファイル」を書き出し、別の端末で取り込む。
// 取り込みは「まだ持っていない op を足すだけ」なので、何度取り込んでも、どの順で取り込んでも結果は同じ。
// 後で WebDAV や自前サーバーに載せ替えるときも、この形(op の集合の送り合い)をそのまま使う。
import * as db from './db.js';
import { fileRefs } from './model.js';

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

export async function importSyncFile(json, recorder) {
  if (!json || json.format !== FORMAT) throw new Error('大学ノートの同期ファイルではありません');
  if (json.version > 1) throw new Error('新しい版の大学ノートで作られたファイルです。アプリを更新してください');
  let newFiles = 0;
  for (const f of json.files || []) {
    if (await db.hasFile(f.hash)) continue;
    const blob = await (await fetch(f.data)).blob();
    await db.putFile({ hash: f.hash, name: f.name, type: f.type, data: blob });
    newFiles++;
  }
  const ops = (json.ops || []).filter((o) => o && typeof o.id === 'string' && typeof o.l === 'number' && o.n && o.t);
  for (const op of ops) recorder.observe(op);
  const added = await db.putOps(ops, recorder.clock);
  const notes = new Set(ops.map((o) => o.n));
  return { added, total: ops.length, newFiles, notes };
}
