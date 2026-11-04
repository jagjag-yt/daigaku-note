// 画面の部品: アイコン(自作の線画)とポップオーバー(小さなメニュー)。

const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  thumbs: '<rect x="4" y="4" width="6.5" height="7" rx="1"/><rect x="13.5" y="4" width="6.5" height="7" rx="1"/><rect x="4" y="14" width="6.5" height="6" rx="1"/><rect x="13.5" y="14" width="6.5" height="6" rx="1"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 010 10h-2"/>',
  redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19 11.5h-9a5 5 0 000 10h2"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  pen: '<path d="M4 20l1.2-4.4L16.6 4.2a1.9 1.9 0 012.7 0l.5.5a1.9 1.9 0 010 2.7L8.4 18.8z"/><path d="M14.5 6.3l3.2 3.2"/>',
  marker: '<path d="M8.5 14.5l7-9.5 3.5 2.6-7 9.5z"/><path d="M8.5 14.5l-1.4 3.3 2.2 1.6 2.7-2.3"/><path d="M4 21h7" stroke-width="2.6"/>',
  eraser: '<path d="M8.5 19.5L3.8 14.8a1.6 1.6 0 010-2.3l8.4-8.4a1.6 1.6 0 012.3 0l5.6 5.6a1.6 1.6 0 010 2.3L12.2 19.5z"/><path d="M9 8.5l6.5 6.5"/><path d="M8.5 19.5H20"/>',
  lasso: '<path d="M7.5 15.5C4.5 14.3 3 12.4 3 10.4 3 6.8 7 4 12 4s9 2.8 9 6.4-4 6.4-9 6.4c-1 0-2-.1-3-.3" stroke-dasharray="2.6 2.4"/><path d="M8.6 14.8c-1.5.6-2 2-1.2 3.1.9 1.1 2.4.6 2.4-.7 0-1.3-1-1.7-2.4-.9-1.6.9-2.7 2.6-3.1 4.2"/>',
  shapes: '<circle cx="8" cy="8.5" r="4.2"/><path d="M13 20.5l4-7 4 7z"/><rect x="3.5" y="15" width="5.5" height="5.5" rx=".6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 00.6-7.95A5.5 5.5 0 007.4 9.1 4.7 4.7 0 007 18.5z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5"/>',
  export: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13"/>',
  pdf: '<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/><path d="M12.75 11v6M9.75 14h6"/>',
  page: '<path d="M7 3.5h10a1 1 0 011 1v15a1 1 0 01-1 1H7a1 1 0 01-1-1v-15a1 1 0 011-1z"/><path d="M12 9v6M9 12h6"/>',
  finger: '<path d="M9 11V5.5a1.5 1.5 0 013 0V11"/><path d="M12 10.5V9a1.5 1.5 0 013 0v2"/><path d="M15 10.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-.7a5 5 0 01-4.1-2.1L5 15.7a1.5 1.5 0 012.3-1.9L9 15.5"/>',
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/>',
  palette: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.5" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="10" r="1.2" fill="currentColor"/><path d="M12 20.5c-1.5 0-2-1.3-1.3-2.4.8-1.2 2.3-1.1 3.8-1.1h2.3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  file: '<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/>',
  import: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  notebook: '<rect x="5.5" y="3.5" width="13" height="17" rx="1.5"/><path d="M9 3.5v17M3.5 7.5h3.5M3.5 12h3.5M3.5 16.5h3.5"/>',
};

export function icon(name, size = 22) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// data-icon="名前" を持つ要素にアイコンを差し込む(文字のラベルがあれば後ろに残す)
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.ic')) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, +el.dataset.iconSize || 22));
  }
}

// ---------- ポップオーバー ----------
let current = null;

export function closePopover() {
  if (!current) return;
  const c = current;
  current = null;
  const hadFocus = c.el.contains(document.activeElement);
  c.el.remove();
  if (hadFocus && c.anchor?.isConnected) c.anchor.focus({ preventScroll: true });
  c.anchor?.classList.remove('open');
  document.removeEventListener('pointerdown', c.outside, true);
  document.removeEventListener('keydown', c.key, true);
  window.removeEventListener('resize', c.reposition);
  document.removeEventListener('scroll', c.onScroll, true);
  c.onClose?.();
}

export const popoverOpen = () => !!current;
export const popoverAnchor = () => current?.anchor || null;

// anchor の下(入りきらなければ上)に出す。build(el, close) で中身を作る。
export function openPopover(anchor, build, { className = '', onClose, align = 'center' } = {}) {
  const same = current && current.anchor === anchor;
  closePopover();
  if (same) return null; // もう一度押したら閉じる
  const el = document.createElement('div');
  el.className = 'pop ' + className;
  el.setAttribute('role', 'dialog');
  const arrow = document.createElement('div');
  arrow.className = 'pop-arrow';
  const body = document.createElement('div');
  body.className = 'pop-body';
  el.append(arrow, body);
  document.body.appendChild(el);
  const c = { el, anchor, onClose, align };
  current = c;
  anchor?.classList.add('open');
  build(body, closePopover);
  c.reposition = () => place(el, arrow, anchor, align);
  c.reposition();
  c.outside = (e) => {
    if (el.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return; // ボタン自身の onclick に任せる
    // ページの上を触ったときは閉じるだけにして、線は書かない
    // (指のときはスクロールできるように通す)
    if (e.target.closest?.('#scroller') && e.pointerType !== 'touch') { e.stopPropagation(); e.preventDefault(); }
    closePopover();
  };
  // 一覧などをスクロールしたらボタンに付いていく。ボタンが消えた・見えなくなったら閉じる
  c.onScroll = (e) => {
    if (el.contains(e.target)) return;
    if (!anchor || !anchor.isConnected) return closePopover();
    const r = anchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return closePopover();
    c.reposition();
  };
  c.key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePopover(); return; }
    // メニューは上下の矢印キーで項目を移れる
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && el.contains(document.activeElement) && !document.activeElement.matches('input, select')) {
      const items = [...el.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  };
  setTimeout(() => {
    if (current !== c) return;
    document.addEventListener('pointerdown', c.outside, true);
    document.addEventListener('keydown', c.key, true);
    window.addEventListener('resize', c.reposition);
    document.addEventListener('scroll', c.onScroll, true);
  });
  // キーボードで開いたときのために、最初の項目へフォーカスを移す(画面は動かさない)
  if (!matchMedia('(pointer: coarse)').matches) el.querySelector('button:not(:disabled), input, select')?.focus({ preventScroll: true });
  return el;
}

export function repositionPopover() { current?.reposition(); }

// アンカーのボタンが作り直されたときに付け替える
export function retargetPopover(oldAnchor, newAnchor) {
  if (!current || current.anchor !== oldAnchor) return;
  oldAnchor.classList.remove('open');
  current.anchor = newAnchor;
  newAnchor.classList.add('open');
  current.reposition = () => place(current.el, current.el.querySelector('.pop-arrow'), newAnchor, current.align);
  current.reposition();
}

// 画面のうち、切り欠き・ホームバーなどを除いた使える範囲(style.css の --sa-*)
let probe = null;
export function safeRect() {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;top:var(--sa-top);right:var(--sa-right);bottom:var(--sa-bottom);left:var(--sa-left);visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
  }
  return probe.getBoundingClientRect();
}

function place(el, arrow, anchor, align) {
  const vw = window.innerWidth, vh = window.innerHeight, m = 8;
  const sr = safeRect();
  const minX = sr.left + m, maxX = sr.right - m, minY = sr.top + m, maxY = sr.bottom - m;
  el.style.maxHeight = '';
  el.style.maxWidth = maxX - minX + 'px';
  const w = el.offsetWidth, h = el.offsetHeight;
  const r = anchor ? anchor.getBoundingClientRect() : { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3, width: 0 };
  const cx = r.left + r.width / 2;
  let left = align === 'start' ? r.left : align === 'end' ? r.right - w : cx - w / 2;
  left = Math.max(minX, Math.min(maxX - w, left));
  let top = r.bottom + 10;
  let below = true;
  if (top + h > maxY && r.top - 10 - h > minY) { top = r.top - 10 - h; below = false; }
  if (top + h > maxY) el.style.maxHeight = maxY - top + 'px';
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.classList.toggle('above', !below);
  arrow.style.left = Math.max(14, Math.min(w - 14, cx - left)) + 'px';
}

// メニューの項目を作る: items = [{ icon, label, onClick, danger, id, on }] / '-' で区切り
export function menu(body, items, close) {
  body.classList.add('menu');
  for (const it of items) {
    if (it === '-') { body.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); continue; }
    if (it.el) { body.appendChild(it.el); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.danger ? ' danger' : '') + (it.on ? ' checked' : '');
    if (it.id) b.id = it.id;
    if (it.attrs) for (const [k, v] of Object.entries(it.attrs)) b.setAttribute(k, v);
    b.innerHTML = `${it.icon ? icon(it.icon, 20) : '<span class="ic-space"></span>'}<span class="menu-label"></span>${it.on != null ? `<span class="switch${it.on ? ' on' : ''}" aria-hidden="true"></span>` : ''}`;
    b.querySelector('.menu-label').textContent = it.label;
    if (it.disabled) b.disabled = true;
    if (it.on != null) { b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', !!it.on); }
    b.onclick = () => {
      if (!it.keepOpen) close();
      it.onClick?.(b);
    };
    body.appendChild(b);
  }
}
