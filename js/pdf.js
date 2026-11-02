// PDF の読み込み(pdf.js)と書き出し(pdf-lib)。どちらも使うときだけ読み込む。
import * as db from './db.js';
import { pagesOf, strokesOf, widthAt } from './model.js';

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

// 罫線(白紙ページの背景)。canvas と PDF 書き出しの両方で使う線の位置。
export function rulingLines(bg, w, h) {
  const lines = [];
  if (!bg || bg.type !== 'blank') return lines;
  if (bg.ruling === 'lines') {
    const gap = 17.01; // B罫 6mm
    for (let y = 70; y < h - 30; y += gap) lines.push([24, y, w - 24, y]);
  } else if (bg.ruling === 'grid') {
    const gap = 14.17; // 5mm 方眼
    for (let y = gap; y < h; y += gap) lines.push([0, y, w, y]);
    for (let x = gap; x < w; x += gap) lines.push([x, 0, x, h]);
  }
  return lines;
}
export const RULING_COLOR = '#b9c8e3';

// ノートを PDF にする。PDF 由来のページは元の PDF をそのまま使い、その上に手書きを重ねる。
export async function exportPdf(note) {
  const L = await pdfLib();
  const out = await L.PDFDocument.create();
  const srcDocs = new Map();
  const [rr, rg, rb] = hexToRgb(RULING_COLOR);
  for (const pg of pagesOf(note)) {
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
      for (const [x0, y0, x1, y1] of rulingLines(pg.bg, pg.w, pg.h)) {
        page.drawLine({ start: { x: x0, y: pg.h - y0 }, end: { x: x1, y: pg.h - y1 }, thickness: 0.5, color: L.rgb(rr, rg, rb) });
      }
    }
    const map = viewToPdf(page);
    for (const e of strokesOf(note, pg.id)) {
      const d = e.data;
      const [r, g, b] = hexToRgb(d.color);
      const color = L.rgb(r, g, b);
      const pts = d.pts;
      if (pts.length === 3) {
        const [x, y] = map(pts[0], pts[1]);
        page.drawCircle({ x, y, size: widthAt(d, pts[2]) / 2, color });
        continue;
      }
      for (let i = 3; i < pts.length; i += 3) {
        const [ax, ay] = map(pts[i - 3], pts[i - 2]);
        const [bx, by] = map(pts[i], pts[i + 1]);
        page.drawLine({
          start: { x: ax, y: ay }, end: { x: bx, y: by },
          thickness: widthAt(d, (pts[i - 1] + pts[i + 2]) / 2),
          color, lineCap: L.LineCapStyle.Round,
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
