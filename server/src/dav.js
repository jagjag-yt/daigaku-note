// WebDAV のまね。アプリの同期(js/webdav.js)が使うところだけを、同じ振る舞いで受ける。
//
// アプリはサーバーを「ただのファイル置き場」として使い、次のものしか送らない:
//   MKCOL     フォルダを作る(201。すでにあれば 405 = アプリは「ある」とみなす)
//   PROPFIND  フォルダの中身(Depth: 1。207 で multistatus の XML。フォルダがなければ 404 = 空とみなす)
//             各項目の resourcetype(フォルダか)と getetag(中身が変わると変わる目印)を見る
//   PUT       ファイルを置く(201 / 204)
//   GET・HEAD ファイルを読む・あるか確かめる(200 / 404)
//
// 利用者ごとに /dav/ が自分だけの置き場(ほかの人のものは見えない)。中に置けるのは次の形だけ:
//   /dav/daigaku-note/                                    フォルダ(いつもある)
//   /dav/daigaku-note/ops/                                フォルダ(いつもある)
//   /dav/daigaku-note/ops/<端末ID>/                       フォルダ(MKCOL か、中へ PUT したときにできる)
//   /dav/daigaku-note/ops/<端末ID>/<開始>-<終了>.json     変更のファイル → D1 の op_files に1行
//   /dav/daigaku-note/files/                              フォルダ(いつもある)
//   /dav/daigaku-note/files/<sha256>.<拡張子>             PDF・画像 → R2 の u/<利用者ID>/files/<名前>(大きさは D1 の blobs)
// ほかの形の住所は、読むときは 404、書くときは 403 で断る。消す(DELETE)・動かす(MOVE)は受けない(追記だけの置き場)。
//
// ETag:
//   ops/<端末ID>/ … op_logs.ver(そのフォルダに書くたびに増える)。アプリはこれが前と同じフォルダの中を見ない
//   上のフォルダ … users.ver(利用者のどこかに書くたびに増える。Nextcloud と同じく、中が変わると上も変わる)
//   変更のファイル … 書いたときのフォルダの ver
//   PDF・画像 … 名前(中身の SHA-256)と大きさ
// どれにも利用者 ID の一部を入れ、退会して作り直したときに、前の利用者の ETag と同じにならないようにする。

import { allowRate, fail, newId, nowIso, readLimited, xmlEscape } from './lib.js';

/** 1人が使える量(変更のファイル + PDF・画像)。超える書き込みは 507(容量不足)で断る。 */
export const QUOTA_BYTES = 1024 * 1024 * 1024;

/**
 * 変更のファイル1つの上限。D1 は1行 2MB までなので、それより少し下で断る(413)。
 * アプリは約500KBずつに分けて送る。送り直し(大きくなりうる)が断られても、アプリはふつうに送り直す。
 */
export const MAX_OP_BYTES = 1900 * 1000;

/**
 * PDF・画像1つの上限。Cloudflare の無料プランは要求の本文が 100MB まで(それを超えると Workers に届く前に断られる)。
 * 413 を返すと、アプリはそのファイルを送らずに変更だけ送り、「送れませんでした」と表示する。
 */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;

/** 1人が持てる変更のフォルダ(アプリの端末ID)の数。入れ直すたびに増えるが、200 あれば足りる。 */
const MAX_OP_DIRS = 200;

/**
 * 1人が1時間に書き込める回数(PUT とフォルダ作り)。D1 の書き込みの無料枠(1日10万行)を1人で使い切れないように。
 * アプリは書いてから4秒ほど待ってまとめて送るので、ふだんは1時間に数十〜数百回。
 */
const WRITES_PER_HOUR = 1200;

const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const OP_NAME = /^(\d{1,15})-(\d{1,15})\.json$/;
// 名前は中身の SHA-256(16進64桁)。暗号の機能がない古い環境のアプリは x で始まる乱数の名前を使う(js/pdf.js)
const FILE_NAME = /^([a-z0-9]{1,128})\.(pdf|png|jpg|gif|webp|bin)$/;
const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bin: 'application/octet-stream' };
const pad = (n) => String(n).padStart(9, '0');

const quota = (env) => Number(env.QUOTA_BYTES) || QUOTA_BYTES;
const maxFile = (env) => Number(env.MAX_FILE_BYTES) || MAX_FILE_BYTES;

/**
 * 住所を読み解く。/dav の外なら null。
 * 戻り値の kind: root / app / ops / files(いつもあるフォルダ)、opdir(端末のフォルダ)、opfile、file、bad(置けない形)
 */
export function parseDavPath(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return pathname === '/dav' || pathname.startsWith('/dav/') ? { kind: 'bad' } : null;
  }
  if (p !== '/dav' && !p.startsWith('/dav/')) return null;
  const slash = p.endsWith('/') || p === '/dav';
  const parts = p === '/dav' ? [] : p.slice(5).split('/');
  if (slash && parts.length) parts.pop();
  // 空の区切り(//)・. や .. ・逆スラッシュ・制御文字は、どこにあっても断る
  if (parts.some((s) => !s || s === '.' || s === '..' || /[\\\0-\x1f]/.test(s))) return { kind: 'bad' };
  const [app, area, a, b, ...rest] = parts;
  if (rest.length) return { kind: 'bad' };
  if (app === undefined) return { kind: 'root' };
  if (app !== 'daigaku-note') return { kind: 'bad' };
  if (area === undefined) return { kind: 'app' };
  if (area === 'ops') {
    if (a === undefined) return { kind: 'ops' };
    if (!DEVICE.test(a)) return { kind: 'bad' };
    if (b === undefined) return { kind: 'opdir', device: a };
    const m = slash ? null : OP_NAME.exec(b);
    if (!m) return { kind: 'bad' };
    const from = Number(m[1]), to = Number(m[2]);
    // 名前は1つの形だけ(9桁にそろえた番号)。同じ範囲が別の名前で2つできないように
    if (from > to || b !== `${pad(from)}-${pad(to)}.json`) return { kind: 'bad' };
    return { kind: 'opfile', device: a, from, to, name: b };
  }
  if (area === 'files') {
    if (a === undefined) return { kind: 'files' };
    const m = slash || b !== undefined ? null : FILE_NAME.exec(a);
    if (!m) return { kind: 'bad' };
    return { kind: 'file', name: a, stem: m[1], ext: m[2] };
  }
  return { kind: 'bad' };
}

const COLLECTIONS = new Set(['root', 'app', 'ops', 'files']);
const HREF = { root: '/dav/', app: '/dav/daigaku-note/', ops: '/dav/daigaku-note/ops/', files: '/dav/daigaku-note/files/' };
const opdirHref = (device) => `${HREF.ops}${encodeURIComponent(device)}/`;
const blobKey = (user, name) => `u/${user.user_id}/files/${name}`;

// ETag(説明はこのファイルの始め)
const uidTag = (user) => String(user.user_id).slice(2, 10);
const rootTag = (user) => `"${uidTag(user)}-r${user.ver}"`;
const dirTag = (user, ver) => `"${uidTag(user)}-d${ver}"`;
const opTag = (user, ver) => `"${uidTag(user)}-o${ver}"`;
const blobTag = (stem, bytes) => `"${stem}-${bytes}"`;

const noBody = (status, headers = {}) => new Response(null, { status, headers });
const notAllowed = (allow) => noBody(405, { allow });

/**
 * /dav/ への要求を受ける。user は authenticate() が返したもの(user_id・ver・bytes_used)。
 */
export async function handleDav(request, env, user, path) {
  switch (request.method) {
    case 'PROPFIND': return propfind(request, env, user, path);
    case 'GET': case 'HEAD': return read(request, env, user, path);
    case 'PUT': case 'MKCOL': {
      if (path.kind === 'bad') return fail(403, 'この場所には書き込めません。');
      if (!(await allowRate(env.DB, `dav:w:${user.user_id}`, WRITES_PER_HOUR, 60 * 60))) {
        return fail(429, '書き込みの回数が上限に達しました。しばらく待ってからお試しください。');
      }
      return request.method === 'PUT' ? put(request, env, user, path) : mkcol(env, user, path);
    }
    default:
      return notAllowed(allowFor(path));
  }
}

const allowFor = (path) => (COLLECTIONS.has(path.kind) || path.kind === 'opdir' ? 'OPTIONS, PROPFIND, MKCOL' : 'OPTIONS, PROPFIND, GET, HEAD, PUT');

// ---- PROPFIND -------------------------------------------------------------

function entry(href, { dir, etag, length }) {
  return '<d:response>' +
    `<d:href>${xmlEscape(href)}</d:href>` +
    '<d:propstat><d:prop>' +
    `<d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype>` +
    `<d:getetag>${xmlEscape(etag)}</d:getetag>` +
    (length != null ? `<d:getcontentlength>${length}</d:getcontentlength>` : '') +
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
    '</d:response>';
}

function multistatus(entries) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`;
  return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
}

async function propfind(request, env, user, path) {
  // Depth は 0 と 1 だけ(全部をたどる infinity は断る。RFC 4918 の propfind-finite-depth)
  const depth = request.headers.get('depth') ?? 'infinity';
  if (depth !== '0' && depth !== '1') return fail(403, 'Depth は 0 か 1 にしてください。');
  const deep = depth === '1';
  const db = env.DB;
  switch (path.kind) {
    case 'root':
      return multistatus([entry(HREF.root, { dir: true, etag: rootTag(user) }), ...(deep ? [entry(HREF.app, { dir: true, etag: rootTag(user) })] : [])]);
    case 'app':
      return multistatus([
        entry(HREF.app, { dir: true, etag: rootTag(user) }),
        ...(deep ? [entry(HREF.ops, { dir: true, etag: rootTag(user) }), entry(HREF.files, { dir: true, etag: rootTag(user) })] : []),
      ]);
    case 'ops': {
      const out = [entry(HREF.ops, { dir: true, etag: rootTag(user) })];
      if (deep) {
        // 端末のフォルダの一覧と ETag。索引(主キー)を1回引くだけ
        const rows = await db.prepare('SELECT device, ver FROM op_logs WHERE user_id = ? ORDER BY device').bind(user.user_id).all();
        for (const r of rows.results) out.push(entry(opdirHref(r.device), { dir: true, etag: dirTag(user, r.ver) }));
      }
      return multistatus(out);
    }
    case 'files': {
      const out = [entry(HREF.files, { dir: true, etag: rootTag(user) })];
      if (deep) {
        const rows = await db.prepare('SELECT name, bytes FROM blobs WHERE user_id = ? ORDER BY name').bind(user.user_id).all();
        for (const r of rows.results) {
          out.push(entry(HREF.files + r.name, { etag: blobTag(r.name.replace(/\.[^.]+$/, ''), r.bytes), length: r.bytes }));
        }
      }
      return multistatus(out);
    }
    case 'opdir': {
      const [dir, files] = await db.batch([
        db.prepare('SELECT ver FROM op_logs WHERE user_id = ? AND device = ?').bind(user.user_id, path.device),
        db.prepare('SELECT from_n, to_n, bytes, ver FROM op_files WHERE user_id = ? AND device = ? ORDER BY to_n, from_n')
          .bind(user.user_id, path.device),
      ]);
      const d = dir.results[0];
      if (!d) return noBody(404); // フォルダがない: アプリは「中身なし」とみなす
      const href = opdirHref(path.device);
      const out = [entry(href, { dir: true, etag: dirTag(user, d.ver) })];
      if (deep) {
        for (const f of files.results) {
          out.push(entry(`${href}${pad(f.from_n)}-${pad(f.to_n)}.json`, { etag: opTag(user, f.ver), length: f.bytes }));
        }
      }
      return multistatus(out);
    }
    case 'opfile': {
      const f = await db.prepare('SELECT bytes, ver FROM op_files WHERE user_id = ? AND device = ? AND from_n = ? AND to_n = ?')
        .bind(user.user_id, path.device, path.from, path.to).first();
      if (!f) return noBody(404);
      return multistatus([entry(`${opdirHref(path.device)}${path.name}`, { etag: opTag(user, f.ver), length: f.bytes })]);
    }
    case 'file': {
      const f = await db.prepare('SELECT bytes FROM blobs WHERE user_id = ? AND name = ?').bind(user.user_id, path.name).first();
      if (!f) return noBody(404);
      return multistatus([entry(HREF.files + path.name, { etag: blobTag(path.stem, f.bytes), length: f.bytes })]);
    }
    default:
      return noBody(404);
  }
}

// ---- GET・HEAD ------------------------------------------------------------

async function read(request, env, user, path) {
  const head = request.method === 'HEAD';
  if (path.kind === 'opfile') {
    const cols = head ? 'bytes, ver' : 'bytes, ver, body';
    const f = await env.DB.prepare(`SELECT ${cols} FROM op_files WHERE user_id = ? AND device = ? AND from_n = ? AND to_n = ?`)
      .bind(user.user_id, path.device, path.from, path.to).first();
    if (!f) return noBody(404);
    const headers = { 'content-type': 'application/json; charset=utf-8', etag: opTag(user, f.ver) };
    return head ? noBody(200, { ...headers, 'content-length': String(f.bytes) }) : new Response(f.body, { status: 200, headers });
  }
  if (path.kind === 'file') {
    // あるかどうかは R2 で決める(中身の置き場が正)。D1 の blobs は容量の計算用
    const obj = head ? await env.FILES.head(blobKey(user, path.name)) : await env.FILES.get(blobKey(user, path.name));
    if (!obj) return noBody(404);
    const headers = { 'content-type': FILE_TYPES[path.ext], 'content-length': String(obj.size), etag: blobTag(path.stem, obj.size) };
    return new Response(head ? null : obj.body, { status: 200, headers });
  }
  if (COLLECTIONS.has(path.kind) || path.kind === 'opdir') return notAllowed(allowFor(path));
  return noBody(404);
}

// ---- MKCOL ----------------------------------------------------------------

async function mkcol(env, user, path) {
  if (COLLECTIONS.has(path.kind)) return notAllowed(allowFor(path)); // いつもある: アプリは 405 を「ある」とみなす
  if (path.kind !== 'opdir') return fail(403, 'ここにはフォルダを作れません。');
  const db = env.DB;
  const [made, exists] = await db.batch([
    db.prepare(
      'INSERT INTO op_logs (user_id, device, ver, latest_end, created_at) ' +
        'SELECT ?1, ?2, 0, 0, ?3 WHERE (SELECT COUNT(*) FROM op_logs WHERE user_id = ?1) < ?4 ' +
        'ON CONFLICT (user_id, device) DO NOTHING',
    ).bind(user.user_id, path.device, nowIso(), MAX_OP_DIRS),
    db.prepare('SELECT ver FROM op_logs WHERE user_id = ? AND device = ?').bind(user.user_id, path.device),
  ]);
  if (made.meta.changes) {
    await db.prepare('UPDATE users SET ver = ver + 1 WHERE id = ?').bind(user.user_id).run();
    return noBody(201);
  }
  if (exists.results.length) return notAllowed(allowFor(path));
  return fail(507, `端末のフォルダは${MAX_OP_DIRS}個までです。`);
}

// ---- PUT ------------------------------------------------------------------

async function put(request, env, user, path) {
  if (COLLECTIONS.has(path.kind) || path.kind === 'opdir') return notAllowed(allowFor(path));
  if (path.kind === 'opfile') return putOpFile(request, env, user, path);
  return putBlob(request, env, user, path);
}

const tooBig = (what) => fail(413, `${what}が大きすぎます。`);
const quotaFull = (env) => fail(507, `保存できる量(${Math.round(quota(env) / 1024 / 1024)}MB)を超えます。`);

/**
 * 変更のファイルを D1 に置く。
 *
 * 容量の確保・フォルダの ver を増やす・ファイルの行を書く、を1つの batch(まとめて成功か、まとめて失敗)で行う。
 * 容量を超えるときは users の UPDATE が0行になり、その合言葉(write_id)が入らないので、続く2つの INSERT も何もしない。
 * (「読む → 判定 → 書く」に分けると、同時に来た書き込みが古い使用量を読んで上限をすり抜ける)
 */
async function putOpFile(request, env, user, path) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_OP_BYTES) return tooBig('変更のファイル');
  const buf = await readLimited(request, MAX_OP_BYTES);
  if (!buf) return tooBig('変更のファイル');
  let body;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return fail(400, '変更のファイルは UTF-8 の文字にしてください。');
  }
  const bytes = buf.byteLength;
  const db = env.DB;
  const uid = user.user_id;
  const nonce = newId('w');
  const now = nowIso();
  const old = 'COALESCE((SELECT bytes FROM op_files WHERE user_id = ?1 AND device = ?2 AND from_n = ?3 AND to_n = ?4), 0)';
  const [prev, reserved, , , dir] = await db.batch([
    db.prepare('SELECT bytes FROM op_files WHERE user_id = ? AND device = ? AND from_n = ? AND to_n = ?').bind(uid, path.device, path.from, path.to),
    db.prepare(
      `UPDATE users SET bytes_used = bytes_used + ?5 - ${old}, ver = ver + 1, write_id = ?6 ` +
        `WHERE id = ?1 AND bytes_used + ?5 - ${old} <= ?7 ` +
        // 新しい端末のフォルダを作ることになるなら、フォルダの数の上限も見る
        'AND (EXISTS (SELECT 1 FROM op_logs WHERE user_id = ?1 AND device = ?2) OR (SELECT COUNT(*) FROM op_logs WHERE user_id = ?1) < ?8)',
    ).bind(uid, path.device, path.from, path.to, bytes, nonce, quota(env), MAX_OP_DIRS),
    db.prepare(
      'INSERT INTO op_logs (user_id, device, ver, latest_end, created_at) ' +
        'SELECT ?1, ?2, 1, ?3, ?4 WHERE (SELECT write_id FROM users WHERE id = ?1) = ?5 ' +
        'ON CONFLICT (user_id, device) DO UPDATE SET ver = op_logs.ver + 1, latest_end = max(op_logs.latest_end, excluded.latest_end)',
    ).bind(uid, path.device, path.to, now, nonce),
    db.prepare(
      'INSERT INTO op_files (user_id, device, from_n, to_n, bytes, ver, created_at, body) ' +
        'SELECT ?1, ?2, ?3, ?4, ?5, (SELECT ver FROM op_logs WHERE user_id = ?1 AND device = ?2), ?6, ?7 ' +
        'WHERE (SELECT write_id FROM users WHERE id = ?1) = ?8 ' +
        'ON CONFLICT (user_id, device, from_n, to_n) DO UPDATE SET ' +
        'bytes = excluded.bytes, ver = excluded.ver, created_at = excluded.created_at, body = excluded.body',
    ).bind(uid, path.device, path.from, path.to, bytes, now, body, nonce),
    db.prepare('SELECT ver FROM op_logs WHERE user_id = ? AND device = ?').bind(uid, path.device),
  ]);
  if (!reserved.meta.changes) return quotaFull(env);
  return noBody(prev.results.length ? 204 : 201, { etag: opTag(user, dir.results[0].ver) });
}

/**
 * PDF・画像を R2 に置く。
 *
 * 先に容量を確保して blobs の行を書き(1つの batch)、それから R2 へ流し込む(Workers のメモリに全部は載せない)。
 * R2 に置けなかったら、確保した分を戻す。
 */
async function putBlob(request, env, user, path) {
  const header = request.headers.get('content-length');
  const len = header === null ? NaN : Number(header);
  // 長さが分からない本文は R2 に流し込めない(ブラウザ・アプリの送り方なら必ず付く)
  if (!Number.isSafeInteger(len) || len < 0) return fail(411, '本文の長さ(Content-Length)が必要です。');
  if (len > maxFile(env)) return tooBig('ファイル');
  const db = env.DB;
  const uid = user.user_id;
  const nonce = newId('w');
  const old = 'COALESCE((SELECT bytes FROM blobs WHERE user_id = ?1 AND name = ?2), 0)';
  const [prev, reserved] = await db.batch([
    db.prepare('SELECT bytes FROM blobs WHERE user_id = ? AND name = ?').bind(uid, path.name),
    db.prepare(`UPDATE users SET bytes_used = bytes_used + ?3 - ${old}, ver = ver + 1, write_id = ?4 WHERE id = ?1 AND bytes_used + ?3 - ${old} <= ?5`)
      .bind(uid, path.name, len, nonce, quota(env)),
    db.prepare(
      'INSERT INTO blobs (user_id, name, bytes, created_at) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT write_id FROM users WHERE id = ?1) = ?5 ' +
        'ON CONFLICT (user_id, name) DO UPDATE SET bytes = excluded.bytes, created_at = excluded.created_at',
    ).bind(uid, path.name, len, nowIso(), nonce),
  ]);
  if (!reserved.meta.changes) return quotaFull(env);
  const before = prev.results[0]?.bytes ?? null;
  let stored;
  try {
    stored = await env.FILES.put(blobKey(user, path.name), request.body ?? new Uint8Array(0), { httpMetadata: { contentType: FILE_TYPES[path.ext] } });
  } catch (err) {
    console.log('r2 put failed', String(err));
    // 確保した分を戻す(前からあったファイルなら、前の大きさに戻す)
    await db.batch([
      db.prepare('UPDATE users SET bytes_used = bytes_used - ?2 + ?3 WHERE id = ?1').bind(uid, len, before ?? 0),
      before === null
        ? db.prepare('DELETE FROM blobs WHERE user_id = ? AND name = ?').bind(uid, path.name)
        : db.prepare('UPDATE blobs SET bytes = ?3 WHERE user_id = ?1 AND name = ?2').bind(uid, path.name, before),
    ]).catch((e) => console.log('r2 rollback failed', String(e)));
    return fail(500, 'ファイルを保存できませんでした。');
  }
  return noBody(before === null ? 201 : 204, { etag: blobTag(path.stem, stored?.size ?? len) });
}
