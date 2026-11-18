// 外から届いた op(同期ファイルの取り込み・クラウド同期)を、端末のデータベースに入れる前に確かめる。
//
// 他人が書き出したノートのファイルや、ほかの端末から届く op は信用しない。
// 形の違う値がそのまま画面の HTML や SVG に入ると、スクリプトを動かされるおそれがあるため。
//   ・ID(ノート・ページ・線・端末)は英数字と - _ の64文字まで。違う op は捨てる
//   ・色は #RGB・#RRGGBB・#RRGGBBAA などの形だけを通す。違う色は黒にする(線そのものは残す)
//   ・PDF・画像のハッシュは16進64桁
//   ・必要な中身(線の点の並び、ページの大きさなど)が欠けている op は捨てる(読み込みで止まらないように)
// 知らない種類の op は、新しい版のアプリが書いたものとして、形の基本だけを確かめて通す。
// DOM には依存しない(Node でテストできる)。

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_TEXT = 1_000_000; // テキストボックスの文字数(長い文章を黙って切らない大きさ)
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const FILE_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);

export const isId = (v) => typeof v === 'string' && ID.test(v);
export const isHash = (v) => typeof v === 'string' && HASH.test(v);
export const isColor = (v) => typeof v === 'string' && COLOR.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optId = (v) => v === undefined || v === null || isId(v);
const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
// 色がない(null・なし)ときはそのまま。形の違う文字などは黒にする
const color = (v, fallback = '#000000') => (v === null || v === undefined || isColor(v) ? v : fallback);

/** 背景(ページの用紙・PDF)。PDF のハッシュが変なら背景をなくす */
function cleanBg(bg) {
  if (!isObj(bg)) return null;
  if (bg.hash !== undefined && !isHash(bg.hash)) return null;
  if (bg.tpl !== undefined && !isId(bg.tpl)) return null;
  const out = { ...bg };
  if (out.paper !== undefined && typeof out.paper !== 'string') delete out.paper;
  if (out.ruling !== undefined && typeof out.ruling !== 'string') delete out.ruling;
  for (const k of ['type', 'paper', 'ruling']) if (typeof out[k] === 'string' && !/^[A-Za-z0-9_-]{1,40}$/.test(out[k])) delete out[k];
  return out;
}

/** 線・画像・テキストボックス(stroke.add / item.add の p.s) */
function cleanStroke(s) {
  if (!isObj(s) || !isId(s.id) || !isId(s.pageId)) return null;
  if (!Array.isArray(s.pts)) return null;
  const out = { ...s };
  if ('color' in out) out.color = color(out.color);
  if (out.tool !== undefined && (typeof out.tool !== 'string' || !/^[a-z-]{1,20}$/.test(out.tool))) return null;
  if (out.nib !== undefined && (typeof out.nib !== 'string' || !/^[a-z-]{1,20}$/.test(out.nib))) delete out.nib;
  if (out.width !== undefined && !isNum(out.width)) out.width = 1;
  if (out.size !== undefined && !isNum(out.size)) out.size = 16;
  if (out.hash !== undefined && !isHash(out.hash)) return null;
  // 画像の種類は決まったものだけ(text/html などの Blob を作らせない)
  if (out.mime !== undefined && !IMAGE_TYPES.has(out.mime)) delete out.mime;
  if (out.text !== undefined) out.text = str(out.text);
  if (out.foot !== undefined) out.foot = str(out.foot, 500);
  if (out.font !== undefined && typeof out.font !== 'string') delete out.font;
  if (out.fill !== undefined && out.fill !== null) out.fill = isColor(out.fill) ? out.fill : null;
  if (out.border !== undefined && out.border !== null) {
    out.border = isObj(out.border) && isNum(out.border.w) ? { ...out.border, color: color(out.border.color) } : null;
  }
  return out;
}

/**
 * op を1つ確かめる。使えるなら(必要なら直した)op、使えないなら null。
 * 渡された op は書き換えない。
 */
export function cleanOp(op) {
  if (!isObj(op)) return null;
  if (typeof op.id !== 'string' || op.id.length > 160 || !isId(op.d) || !isId(op.n) || typeof op.t !== 'string' || op.t.length > 40) return null;
  if (!isNum(op.l) || op.l < 0 || (op.c !== undefined && !isNum(op.c)) || (op.ts !== undefined && !isNum(op.ts))) return null;
  if (op.p !== undefined && op.p !== null && !isObj(op.p)) return null;
  const p = { ...(op.p || {}) };
  const out = { ...op, p };

  switch (op.t) {
    case 'note.create':
      if (p.cover !== undefined && !isColor(p.cover)) delete p.cover;
      if (p.folder !== undefined && !optId(p.folder)) delete p.folder;
      p.title = str(p.title, 500);
      break;
    case 'note.rename':
      p.title = str(p.title, 500);
      break;
    case 'note.cover':
      if (!isColor(p.cover)) return null;
      break;
    case 'note.move':
      if (!optId(p.folder)) return null;
      break;
    case 'folder.create':
      if (!optId(p.parent)) delete p.parent;
      p.name = str(p.name, 500);
      break;
    case 'folder.rename':
      p.name = str(p.name, 500);
      break;
    case 'folder.move':
      if (!optId(p.parent)) return null;
      break;
    case 'tpl.add':
      if (!isHash(p.hash) || !isNum(p.page) || !isNum(p.w) || !isNum(p.h)) return null;
      p.name = str(p.name, 500);
      break;
    case 'page.add': {
      const pg = p.page;
      if (!isObj(pg) || !isId(pg.id) || !isNum(pg.w) || !isNum(pg.h) || pg.w <= 0 || pg.h <= 0) return null;
      p.page = { ...pg, order: isNum(pg.order) ? pg.order : 0, bg: cleanBg(pg.bg) };
      break;
    }
    case 'page.delete':
    case 'page.restore':
    case 'page.mark':
      if (!isId(p.pageId)) return null;
      break;
    case 'page.bg':
      if (!isId(p.pageId)) return null;
      p.bg = cleanBg(p.bg);
      break;
    case 'page.title':
      if (!isId(p.pageId)) return null;
      p.title = str(p.title, 500);
      break;
    case 'page.move':
      if (!isId(p.pageId) || !isNum(p.order)) return null;
      break;
    case 'stroke.add':
    case 'item.add':
      p.s = cleanStroke(p.s);
      if (!p.s) return null;
      break;
    case 'stroke.tf': {
      if (!isObj(p.tf)) return null;
      const tf = {};
      for (const [id, off] of Object.entries(p.tf)) {
        if (isId(id) && Array.isArray(off) && off.length === 2 && isNum(off[0]) && isNum(off[1])) tf[id] = [off[0], off[1]];
      }
      p.tf = tf;
      break;
    }
    case 'stroke.style': {
      if (!isObj(p.styles)) return null;
      const styles = {};
      for (const [id, st] of Object.entries(p.styles)) if (isId(id) && isObj(st)) styles[id] = { ...st, color: color(st.color) };
      p.styles = styles;
      break;
    }
    case 'stroke.del':
    case 'stroke.undel':
      if (!Array.isArray(p.ids)) return null;
      p.ids = p.ids.filter(isId);
      break;
    default:
      break;
  }
  return out;
}

/** op の並びを確かめ、使えるものだけを返す */
export const cleanOps = (list) => (Array.isArray(list) ? list.map(cleanOp).filter(Boolean) : []);
