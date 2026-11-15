// 消しゴムで「なぞった所だけ」消すための計算。DOM なし(Node でテストできる)。
//
// 線は点の並び [x, y, 筆圧, x, y, 筆圧, …]。消しゴムの円に入った点を取り除き、残りを切れ目ごとの「かけら」に分ける。
// 図形補正した線は角の点しかない(辺の途中に点がない)ので、先に点を細かく足してから切る。
// 記録は「元の線を消して、残ったかけらを新しい線として足す」(stroke.del + stroke.add)。新しい種類の op は使わない。

// 点の間隔が step を超えるところに、まっすぐ点を足す(筆圧もなめらかにつなぐ)
export function densify(P, step) {
  if (P.length <= 3 || !(step > 0)) return P.slice();
  const out = [P[0], P[1], P[2]];
  for (let i = 3; i < P.length; i += 3) {
    const x0 = P[i - 3], y0 = P[i - 2], p0 = P[i - 1], x1 = P[i], y1 = P[i + 1], p1 = P[i + 2];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t);
    }
    out.push(x1, y1, p1);
  }
  return out;
}

// かけらの並び pieces([[x,y,p,…], …])から、中心 (cx, cy)・半径 r の円に入る点を除く。
// 変わらなければ同じ配列を返す(呼ぶ側で「当たったか」を === で見分けられるように)
export function cutPieces(pieces, cx, cy, r) {
  const rr = r * r;
  let changed = false;
  const out = [];
  for (const P of pieces) {
    let cur = [];
    let hit = false;
    for (let i = 0; i < P.length; i += 3) {
      const dx = P[i] - cx, dy = P[i + 1] - cy;
      if (dx * dx + dy * dy <= rr) {
        hit = true;
        if (cur.length) { out.push(cur); cur = []; }
      } else {
        cur.push(P[i], P[i + 1], P[i + 2]);
      }
    }
    if (!hit) { out.push(P); continue; }
    changed = true;
    if (cur.length) out.push(cur);
  }
  return changed ? out : pieces;
}

// 小さすぎるかけら(点1つ・ごく短いもの)は残さない。元の線が点1つ(「・」)だったときは別
export function keepPieces(pieces, minLen) {
  return pieces.filter((P) => {
    if (P.length < 6) return false;
    let len = 0;
    for (let i = 3; i < P.length; i += 3) len += Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2]);
    return len >= minLen;
  });
}

const r2 = (v) => Math.round(v * 100) / 100;

// かけらを線のデータにする(id は呼ぶ側で付ける)。図形として整えた線のかけらは、印(shape)を残して
// なめらかにしない(角が丸くならないように。js/ink.js の centerline)
export function pieceData(d, P) {
  const { id, ...rest } = d;
  const pts = new Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    pts[i] = r2(P[i]);
    pts[i + 1] = r2(P[i + 1]);
    pts[i + 2] = Math.round(P[i + 2] * 1000) / 1000;
  }
  return { ...rest, pts };
}
