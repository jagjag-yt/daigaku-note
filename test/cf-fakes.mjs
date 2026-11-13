// 同期サーバー(server/)のテスト用の、Cloudflare の代わり。依存は増やさず Node に元からあるものだけで作る。
//   fakeD1  … D1 の代わり。Node の node:sqlite(本物の SQLite)に server/schema.sql を流して使う
//   fakeR2  … R2 の代わり(メモリ上)
//   startWorker … Worker の fetch を本物の HTTP で受ける小さなサーバー(本文の長さなど、通信の形も本物と同じにするため)
import http from 'node:http';
import fs from 'node:fs';

// node:sqlite はまだ「試験中」の機能で、読み込むと警告が出る。テストの出力を汚さないよう、この警告だけ消す
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8');

// D1 と同じく、行を返す文は all()、返さない文は run() で動かす
const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
const plain = (row) => (row ? { ...row } : null);

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 は外部キーを確かめる
  db.exec(SCHEMA);
  const log = [];
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) {
      for (const a of args) if (a === undefined) throw new Error(`D1_TYPE_ERROR: undefined を渡した: ${this.sql}`);
      return new Stmt(this.sql, args);
    }
    exec() {
      log.push(this.sql);
      const st = db.prepare(this.sql);
      if (returnsRows(this.sql)) {
        const results = st.all(...this.args).map(plain);
        return { success: true, results, meta: { changes: /^\s*SELECT/i.test(this.sql) ? 0 : results.length } };
      }
      const r = st.run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(col) {
      const row = this.exec().results[0] ?? null;
      return col && row ? row[col] : row;
    }
    async all() { return this.exec(); }
    async run() { return this.exec(); }
  }
  return {
    sqlite: db,
    log,
    prepare: (sql) => new Stmt(sql),
    // D1 の batch: 順に動かし、どれかが失敗したら全部を取り消す
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    // テストで中を見る・書き換えるため
    q: (sql, ...args) => db.prepare(sql).all(...args).map(plain),
    x: (sql, ...args) => db.prepare(sql).run(...args),
  };
}

async function toBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value.getReader) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('R2 に置けない形');
}

export function fakeR2() {
  const objects = new Map(); // key → { bytes, httpMetadata, uploaded }
  const meta = (key, o) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded, httpMetadata: o.httpMetadata, httpEtag: `"${o.bytes.byteLength}"` });
  return {
    objects,
    failPut: false, // true にすると put が失敗する(戻しのテスト用)
    async put(key, value, opts = {}) {
      const bytes = await toBytes(value);
      if (this.failPut) throw new Error('R2 の書き込みに失敗(テスト)');
      const o = { bytes, httpMetadata: opts.httpMetadata || {}, uploaded: new Date() };
      objects.set(key, o);
      return meta(key, o);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { ...meta(key, o), body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.slice().buffer };
    },
    async delete(keys) {
      for (const k of [].concat(keys)) objects.delete(k);
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map((k) => meta(k, objects.get(k))), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
}

export function fakeEnv(extra = {}) {
  return {
    DB: fakeD1(),
    FILES: fakeR2(),
    SECRET_PEPPER: 'test-pepper',
    RESEND_API_KEY: 're_test',
    MAIL_FROM: '大学ノート <no-reply@example.com>',
    ...extra,
  };
}

/**
 * Worker を本物の HTTP で受けるサーバーを立てる。戻り値の url に fetch すればよい。
 * log には届いた要求(method と path)が順に入る。
 */
export async function startWorker(worker, env) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'connection', 'keep-alive', 'transfer-encoding'].includes(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const url = `http://${req.headers.host}${req.url}`;
      log.push({ method: req.method, path: decodeURIComponent(new URL(url).pathname), headers: Object.fromEntries(headers) });
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && (body.length || headers.has('content-length'));
      const request = new Request(url, { method: req.method, headers, body: hasBody ? body : undefined });
      const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
      const out = {};
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      if (req.method === 'HEAD' || !response.body) return res.end();
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(599);
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Resend への送信を横取りして、送ったメールを mails に入れる(ほかの fetch はそのまま通す)。
 * 戻り値の restore() で元に戻す。
 */
export function captureMail() {
  const real = globalThis.fetch;
  const mails = [];
  const ctl = {
    mails,
    fail: false,
    lastCode: (to) => {
      const m = [...mails].reverse().find((x) => !to || x.to.includes(to));
      return m && /\b(\d{6})\b/.exec(m.text)[1];
    },
    restore: () => { globalThis.fetch = real; },
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      mails.push({ ...JSON.parse(init.body), auth: init.headers.authorization });
      return ctl.fail ? new Response('{"message":"boom"}', { status: 500 }) : new Response('{"id":"x"}', { status: 200 });
    }
    return real(input, init);
  };
  return ctl;
}
