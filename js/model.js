// 大学ノートのデータモデル。
// ノートは「変更(op)の記録」の積み重ねで表す。各 op には {端末ID d, 端末内連番 c, ランポート時計 l} が付く。
// 状態は op をどの順番で適用しても同じになる(LWW レジスタの集まり)ので、
// 端末ごとに書いた op を後から足し合わせるだけで同期(マージ)できる。
// DOM には依存しない(Node でテストできる)。

export const NOTE_TYPES = ['note.create', 'note.rename', 'note.delete', 'note.restore'];

export const PAGE_A4 = { w: 595.28, h: 841.89 };

export function newId(len = 12) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (const b of a) s += chars[b % 36];
  return s;
}

// スタンプの比較: ランポート時計 → 端末ID の順。全端末で同じ結果になる。
export function cmp(a, b) {
  return a.l - b.l || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
}
const newer = (s, reg) => !reg || cmp(s, reg) > 0;

export class Recorder {
  constructor(device, counter = 0, lamport = 0) {
    this.device = device;
    this.counter = counter;
    this.lamport = lamport;
  }
  make(n, t, p) {
    this.counter++;
    this.lamport++;
    return { id: `${this.device}:${this.counter}`, d: this.device, c: this.counter, l: this.lamport, n, t, p, ts: Date.now() };
  }
  observe(op) {
    if (op.l > this.lamport) this.lamport = op.l;
  }
  get clock() {
    return { c: this.counter, l: this.lamport };
  }
}

export function emptyNote(id) {
  return {
    id,
    title: '',
    titleS: null,
    created: null,
    deleted: false,
    delS: null,
    updatedAt: 0,
    pages: new Map(), // pageId -> {id, w, h, bg, order, orderS, alive, aliveS}
    strokes: new Map(), // strokeId -> {id, data, addS, alive, aliveS}
    pageStrokes: new Map(), // pageId -> Set(strokeId)
  };
}

function pageEntry(note, id) {
  let e = note.pages.get(id);
  if (!e) {
    e = { id, w: 0, h: 0, bg: null, bg2: null, bgS: null, order: 0, orderS: null, alive: false, aliveS: null };
    note.pages.set(id, e);
  }
  return e;
}
function strokeEntry(note, id) {
  let e = note.strokes.get(id);
  if (!e) {
    e = { id, data: null, addS: null, alive: false, aliveS: null, bbox: null, off: [0, 0], offS: null, color: null, colorS: null };
    note.strokes.set(id, e);
  }
  return e;
}
function setAlive(e, alive, s) {
  if (newer(s, e.aliveS)) {
    e.alive = alive;
    e.aliveS = s;
  }
}

export function applyOp(note, op) {
  const s = { l: op.l, d: op.d };
  if (op.ts > note.updatedAt) note.updatedAt = op.ts;
  const p = op.p || {};
  switch (op.t) {
    case 'note.create':
      if (note.created == null || op.ts < note.created) note.created = op.ts;
    // fallthrough: 作成時の名前も LWW の一票
    case 'note.rename':
      if (newer(s, note.titleS)) {
        note.title = p.title;
        note.titleS = s;
      }
      break;
    case 'note.delete':
    case 'note.restore':
      if (newer(s, note.delS)) {
        note.deleted = op.t === 'note.delete';
        note.delS = s;
      }
      break;
    case 'page.add': {
      const pg = p.page;
      const e = pageEntry(note, pg.id);
      e.w = pg.w;
      e.h = pg.h;
      e.bg = pg.bg;
      if (newer(s, e.orderS)) {
        e.order = pg.order;
        e.orderS = s;
      }
      setAlive(e, true, s);
      break;
    }
    case 'page.delete':
    case 'page.restore':
      setAlive(pageEntry(note, p.pageId), op.t === 'page.restore', s);
      break;
    case 'page.bg': {
      const e = pageEntry(note, p.pageId);
      if (newer(s, e.bgS)) {
        e.bg2 = p.bg;
        e.bgS = s;
      }
      break;
    }
    case 'page.move': {
      const e = pageEntry(note, p.pageId);
      if (newer(s, e.orderS)) {
        e.order = p.order;
        e.orderS = s;
      }
      break;
    }
    case 'stroke.add': {
      const d = p.s;
      const e = strokeEntry(note, d.id);
      e.data = d;
      e.addS = s;
      e.bbox = bboxOf(d);
      setAlive(e, true, s);
      let set = note.pageStrokes.get(d.pageId);
      if (!set) note.pageStrokes.set(d.pageId, (set = new Set()));
      set.add(d.id);
      break;
    }
    case 'stroke.tf': // 移動(絶対位置のずれ)
      for (const [id, off] of Object.entries(p.tf)) {
        const e = strokeEntry(note, id);
        if (newer(s, e.offS)) {
          e.off = off;
          e.offS = s;
        }
      }
      break;
    case 'stroke.style': // 色の変更
      for (const [id, st] of Object.entries(p.styles)) {
        const e = strokeEntry(note, id);
        if (newer(s, e.colorS)) {
          e.color = st.color;
          e.colorS = s;
        }
      }
      break;
    case 'stroke.del':
    case 'stroke.undel':
      for (const id of p.ids) setAlive(strokeEntry(note, id), op.t === 'stroke.undel', s);
      break;
    default:
      // 知らない種類の op は無視する(新しい版で増えた機能を古い版が壊さないように)
      break;
  }
}

export function buildNote(id, ops) {
  const note = emptyNote(id);
  for (const op of ops) applyOp(note, op);
  return note;
}

// ページの背景(テンプレート変更があればそちらを優先)
export const bgOf = (pg) => (pg.bgS ? pg.bg2 : pg.bg);

// 線の見た目(色の変更・移動を反映したもの)
export function styleOf(e) {
  return e.color ? { ...e.data, color: e.color } : e.data;
}

export function pagesOf(note) {
  return [...note.pages.values()]
    .filter((p) => p.alive && p.w > 0)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export function strokesOf(note, pageId, hidden) {
  const set = note.pageStrokes.get(pageId);
  if (!set) return [];
  const out = [];
  for (const id of set) {
    const e = note.strokes.get(id);
    if (e && e.alive && e.data && !(hidden && hidden.has(id))) out.push(e);
  }
  out.sort((a, b) => cmp(a.addS, b.addS));
  return out;
}

export function buildLibrary(noteOps) {
  const map = new Map();
  for (const op of noteOps) {
    let n = map.get(op.n);
    if (!n) map.set(op.n, (n = emptyNote(op.n)));
    applyOp(n, op);
  }
  return map;
}

export function bboxOf(d) {
  const pts = d.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const m = d.width * 1.5;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

// 点 (px,py) が線分 (ax,ay)-(bx,by) から r 以内か
function nearSeg(px, py, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy <= r * r;
}

export function strokeHit(e, x, y, r) {
  x -= e.off[0];
  y -= e.off[1];
  const b = e.bbox;
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  const pts = e.data.pts;
  const rr = r + e.data.width / 2;
  if (pts.length === 3) return nearSeg(x, y, pts[0], pts[1], pts[0], pts[1], rr);
  for (let i = 3; i < pts.length; i += 3) {
    if (nearSeg(x, y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1], rr)) return true;
  }
  return false;
}

// 筆圧から線の太さ(pt)
export function widthAt(d, p) {
  return d.pr ? d.width * (0.3 + p) : d.width;
}
