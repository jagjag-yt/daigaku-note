// 公開用・アプリ用に集めるファイル(scripts/build-web.mjs)に、サービスワーカーがオフライン用に
// 覚えるファイルが全部入っているか。js/ にファイルを足したときの入れ忘れを見つける。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('www/ に集めたファイルで動く(サービスワーカーの一覧・js/ の全部・読み込むファイル)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'daigaku-www-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs'), out], { stdio: 'pipe' });
    const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const assets = [...sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((a) => a !== './');
    for (const a of assets) assert.ok(fs.existsSync(path.join(out, a)), `${a} が集めたファイルにない`);
    // js/ のファイルは全部サービスワーカーが覚えている(覚えていないとオフラインで起動できない)
    for (const f of fs.readdirSync(path.join(root, 'js'))) assert.ok(assets.includes(`js/${f}`), `sw.js の ASSETS に js/${f} がない`);
    // index.html が読み込むファイルもそろっている
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const [, ref] of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
      const file = ref.split('?')[0];
      assert.ok(fs.existsSync(path.join(out, file)), `index.html の ${file} がない`);
    }
    // マニフェストのアイコンも
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.webmanifest'), 'utf8'));
    for (const ic of mf.icons || []) assert.ok(fs.existsSync(path.join(out, ic.src)), `manifest のアイコン ${ic.src} がない`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
