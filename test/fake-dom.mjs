// js/webdav.js を Node で動かすための、小さな DOMParser(PROPFIND の応答の XML を読むところだけ)。
// 名前空間はきちんと扱う(接頭辞の宣言をたどって DAV: かどうかを決める)。サーバーが名前空間を
// 間違えた XML を返したら、ブラウザと同じく要素が見つからなくなる。形の壊れた XML はエラーにする。
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  if (!(e in ENTITIES)) throw new Error(`知らない実体参照 ${m}`);
  return ENTITIES[e];
});

class Node {
  constructor(ns, localName) {
    this.namespaceURI = ns;
    this.localName = localName;
    this.children = [];
  }
  get textContent() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  getElementsByTagNameNS(ns, local) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        if ((ns === '*' || c.namespaceURI === ns) && (local === '*' || c.localName === local)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function parse(xml) {
  const doc = new Node(null, '#document');
  const stack = [{ node: doc, ns: { xml: 'http://www.w3.org/XML/1998/namespace' }, name: null }];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[7]) throw new Error('XML の形が壊れています');
    if (m[1] !== undefined) { top.node.children.push(m[1]); continue; }
    if (m[6] !== undefined) {
      if (stack.length === 1 && m[6].trim()) throw new Error('XML の外に文字があります');
      top.node.children.push(decode(m[6]));
      continue;
    }
    if (!m[3]) continue; // 宣言・コメント
    const qname = m[3];
    if (m[2]) {
      if (top.name !== qname) throw new Error(`閉じタグが合いません: ${qname}`);
      stack.pop();
      continue;
    }
    const ns = { ...top.ns };
    for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const v = decode(a[2] ?? a[3]);
      if (a[1] === 'xmlns') ns[''] = v;
      else if (a[1].startsWith('xmlns:')) ns[a[1].slice(6)] = v;
    }
    const i = qname.indexOf(':');
    const prefix = i >= 0 ? qname.slice(0, i) : '';
    if (prefix && !(prefix in ns)) throw new Error(`宣言されていない接頭辞: ${prefix}`);
    const el = new Node(ns[prefix] ?? null, i >= 0 ? qname.slice(i + 1) : qname);
    top.node.children.push(el);
    if (!m[5]) stack.push({ node: el, ns, name: qname });
  }
  if (stack.length !== 1) throw new Error('閉じていない要素があります');
  return doc;
}

export class DOMParser {
  parseFromString(text, type) {
    if (!/xml/.test(type)) throw new Error('XML だけ読めます');
    return parse(String(text));
  }
}
