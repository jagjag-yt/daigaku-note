// 公開・アプリに入れるファイルだけを www/ に集める(GitHub Pages とアプリで同じものを使う)。
// 素の JS なのでビルド(変換)はせず、コピーするだけ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['index.html', 'style.css', 'sw.js', 'manifest.webmanifest', 'js', 'vendor', 'icons'];
const out = path.resolve(root, process.argv[2] || 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
console.log(`${path.relative(root, out) || '.'}/ に ${FILES.length} 項目をコピーしました`);
