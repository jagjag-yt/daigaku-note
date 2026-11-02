// PDF の読み込み(pdf.js)と書き出し(pdf-lib)。どちらも使うときだけ読み込む。
import * as db from './db.js';
import { pagesOf, strokesOf, styleOf, bgOf } from './model.js';
import { centerline, outline, smoothClosedPath, linePath, variableWidth } from './ink.js';
import { templatePrims } from './templates.js';

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('../vendor/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsP;
}

let pdfLibP = null;
function pdfLib() {
  if (!pdfLibP) {
    pdfLibP = new Promise((resolve, reject) => {
      if (window.PDFLib) return resolve(window.PDFLib);
      const s = document.createElement('script');
      s.src = new URL('../vendor/pdf-lib.min.js', import.meta.url).href;
      s.onload = () => resolve(window.PDFLib);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return pdfLibP;
}

export async function sha256(buf) {
  if (crypto.subtle) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// PDF ファイルを保存し、ページの大きさの一覧を返す
export async function importPdf(file) {
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  if (!(await db.hasFile(hash))) {
    await db.putFile({ hash, name: file.name, type: 'application/pdf', data: new Blob([buf], { type: 'application/pdf' }) });
  }
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  docCache.set(hash, Promise.resolve(doc));
  return { hash, sizes };
}

const docCache = new Map();
async function loadDoc(hash) {
  if (!docCache.has(hash)) {
    docCache.set(hash, (async () => {
      const f = await db.getFile(hash);
      if (!f) throw new Error('PDFが見つかりません(同期ファイルに含まれていなかった可能性があります)');
      const buf = await f.data.arrayBuffer();
      const lib = await pdfjs();
      return lib.getDocument({ data: new Uint8Array(buf) }).promise;
    })());
  }
  return docCache.get(hash);
}

// 背景用キャンバスに PDF のページを描く。task.cancel() で中断できる。
export async function renderPdfPage(canvas, hash, pageNo, holder) {
  const doc = await loadDoc(hash);
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: canvas.width / vp1.width });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, viewport: vp });
  if (holder) holder.task = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    throw e;
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// PDF のページの文字(検索用)
export async function pdfPageText(hash, pageNo) {
  const doc = await loadDoc(hash);
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  return tc.items.map((i) => i.str).join(' ');
}

// ノートを PDF にする。PDF 由来のページは元の PDF をそのまま使い、その上に手書きをベクターで重ねる。
export async function exportPdf(note) {
  const L = await pdfLib();
  const out = await L.PDFDocument.create();
  const srcDocs = new Map();
  const rgb = (hex) => L.rgb(...hexToRgb(hex));
  for (const pg of pagesOf(note)) {
    const bg = bgOf(pg);
    let page;
    if (pg.bg && pg.bg.type === 'pdf') {
      let src = srcDocs.get(pg.bg.hash);
      if (!src) {
        const f = await db.getFile(pg.bg.hash);
        src = await L.PDFDocument.load(await f.data.arrayBuffer(), { ignoreEncryption: true });
        srcDocs.set(pg.bg.hash, src);
      }
      [page] = await out.copyPages(src, [pg.bg.page - 1]);
      out.addPage(page);
    } else {
      page = out.addPage([pg.w, pg.h]);
      const prim = templatePrims(bg, pg.w, pg.h);
      for (const [x0, y0, x1, y1, t, c] of prim.lines) {
        page.drawLine({ start: { x: x0, y: pg.h - y0 }, end: { x: x1, y: pg.h - y1 }, thickness: t, color: rgb(c) });
      }
      for (const [x, y, r, c] of prim.dots) page.drawCircle({ x, y: pg.h - y, size: r, color: rgb(c) });
    }
    const toPdf = viewToPdf(page);
    for (const e of strokesOf(note, pg.id)) {
      const d = styleOf(e);
      const [ox, oy] = e.off;
      // SVG のパスは y が下向きなので、PDF の座標 (X, Y) を (X, -Y) にして原点に置く
      const map = (x, y) => { const [X, Y] = toPdf(x + ox, y + oy); return [X, -Y]; };
      const marker = d.tool === 'marker';
      const extra = marker ? { opacity: 0.38, borderOpacity: 0.38, blendMode: L.BlendMode.Multiply } : {};
      const line = centerline(d);
      if (variableWidth(d)) {
        page.drawSvgPath(smoothClosedPath(outline(d, line), map), { x: 0, y: 0, color: rgb(d.color), ...extra });
      } else if (line.length === 1) {
        const [X, Y] = toPdf(line[0][0] + ox, line[0][1] + oy);
        page.drawCircle({ x: X, y: Y, size: d.width / 2, color: rgb(d.color), ...extra });
      } else {
        page.drawSvgPath(linePath(line, map), {
          x: 0, y: 0, borderColor: rgb(d.color), borderWidth: d.width,
          borderLineCap: L.LineCapStyle.Round, ...extra,
        });
      }
    }
  }
  return out.save();
}

// 画面上の座標(左上原点・回転後)→ PDF の座標(左下原点・回転前)
function viewToPdf(page) {
  const box = page.getCropBox();
  const cx = box.x, cy = box.y, cw = box.width, ch = box.height;
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  switch (rot) {
    case 90: return (x, y) => [cx + y, cy + x];
    case 180: return (x, y) => [cx + cw - x, cy + y];
    case 270: return (x, y) => [cx + cw - y, cy + ch - x];
    default: return (x, y) => [cx + x, cy + ch - y];
  }
}
