// ページのテンプレート(罫線)と用紙サイズ。画面と PDF 書き出しで共通。

const MM = 72 / 25.4;

export const TEMPLATES = [
  { id: 'lines-a', label: 'A罫(7mm)' },
  { id: 'lines-b', label: 'B罫(6mm)' },
  { id: 'lines-c', label: 'C罫(5mm)' },
  { id: 'grid', label: '方眼(5mm)' },
  { id: 'dots', label: 'ドット(5mm)' },
  { id: 'cornell', label: 'コーネル式' },
  { id: 'music', label: '五線譜' },
  { id: 'none', label: '無地' },
];

export const SIZES = [
  { id: 'a4', label: 'A4 縦', w: 210 * MM, h: 297 * MM },
  { id: 'a4l', label: 'A4 横', w: 297 * MM, h: 210 * MM },
  { id: 'b5', label: 'B5 縦', w: 182 * MM, h: 257 * MM },
  { id: 'a5', label: 'A5 縦', w: 148 * MM, h: 210 * MM },
  { id: 'wide', label: '16:9(スライド)', w: 254 * MM, h: 142.875 * MM },
];

export const RULING_COLOR = '#b9c8e3';
const ACCENT = '#e2a0a0';

// 古いノートの値を読み替える
const alias = { lines: 'lines-b' };

// 背景 → 描く物の一覧 { lines: [[x0,y0,x1,y1,太さ,色]], dots: [[x,y,半径,色]] }
export function templatePrims(bg, w, h) {
  const out = { lines: [], dots: [] };
  if (!bg || bg.type !== 'blank') return out;
  const id = alias[bg.ruling] || bg.ruling;
  const hl = (y, x0 = 24, x1 = w - 24, c = RULING_COLOR, t = 0.5) => out.lines.push([x0, y, x1, y, t, c]);
  const ruled = (gap, top = 22 * MM) => { for (let y = top; y < h - 14 * MM; y += gap) hl(y); };
  switch (id) {
    case 'lines-a': ruled(7 * MM); break;
    case 'lines-b': ruled(6 * MM); break;
    case 'lines-c': ruled(5 * MM); break;
    case 'grid': {
      const g = 5 * MM;
      for (let y = g; y < h; y += g) out.lines.push([0, y, w, y, 0.4, RULING_COLOR]);
      for (let x = g; x < w; x += g) out.lines.push([x, 0, x, h, 0.4, RULING_COLOR]);
      break;
    }
    case 'dots': {
      const g = 5 * MM;
      for (let y = g; y < h; y += g) for (let x = g; x < w; x += g) out.dots.push([x, y, 0.8, '#9fb2d4']);
      break;
    }
    case 'cornell': {
      const top = 22 * MM, cue = w * 0.28, sum = h * 0.78;
      for (let y = top; y < sum; y += 7 * MM) hl(y, 24, w - 24);
      hl(top - 4, 24, w - 24, ACCENT, 1);
      out.lines.push([cue, top - 4, cue, sum, 1, ACCENT]);
      hl(sum, 24, w - 24, ACCENT, 1);
      break;
    }
    case 'music': {
      const gap = 2 * MM, staff = 4 * gap, between = 11 * MM;
      for (let y = 20 * MM; y + staff < h - 15 * MM; y += staff + between) {
        for (let k = 0; k < 5; k++) hl(y + k * gap, 15 * MM, w - 15 * MM, '#8a96aa', 0.5);
      }
      break;
    }
    default: break;
  }
  return out;
}

export function sizeById(id) {
  return SIZES.find((s) => s.id === id) || SIZES[0];
}
