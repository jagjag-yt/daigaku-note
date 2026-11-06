// アプリ版(Android / iOS、Capacitor)とブラウザ版の違いをここにまとめる。
// ブラウザでは何もしない(fetch・<a download> をそのまま使う)。
//
// Capacitor は @capacitor/core を import しなくても、起動時(このファイルより前)に window.Capacitor と
// Capacitor.Plugins.<名前> を用意してくれるので、ビルド(バンドル)なしのまま使える。

const cap = globalThis.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
export const platform = isNative ? cap.getPlatform() : 'web';
const plugin = (name) => (isNative ? cap.Plugins?.[name] : undefined);

// 画面とアプリの中身のあいだで、一度に渡す大きさ(base64 にする前のバイト数。3 の倍数)
const CHUNK = 3 * 256 * 1024;

// ---- 通信 -----------------------------------------------------------------
// アプリの画面は https://localhost(Android)/ capacitor://localhost(iOS)から開くので、
// WebDAV サーバーへの fetch はブラウザと同じく CORS で止められる。
// アプリでは OS の通信機能を直接使い、CORS を通らないようにする。
//   Android: このアプリ専用のプラグイン DavHttp(PROPFIND・MKCOL を送れる。Capacitor 標準の
//            CapacitorHttp は Java の HttpURLConnection を使うので、この2つを送れない)。
//            大きな PDF でもメモリが足りなくならないよう、本文はファイルを通して渡す
//   iOS:     Capacitor 標準の CapacitorHttp(URLSession はどんなメソッドでも送れる)
//
// 戻り値は fetch と同じ Response。失敗の形も fetch に合わせる:
//   つながらない → TypeError、取り消し・時間切れ → name が 'AbortError' のエラー
// idleTimeout: 何も届かない(送れない)時間がこれを超えたら時間切れ(ミリ秒)。アプリ版だけが使う。
//   ブラウザ版では呼ぶ側が signal で時間切れを作る。
// リダイレクト(3xx)は、Android では追いかけずにそのまま返す(DavHttpPlugin.java を参照)。
let reqSeq = 0;
export async function http(url, { method = 'GET', body = null, headers = {}, signal, idleTimeout = 60_000 } = {}) {
  if (!isNative) return fetch(url, { method, body, headers, cache: 'no-store', signal });
  const id = `r${Date.now().toString(36)}${(++reqSeq).toString(36)}`;
  const hasBody = body != null && method !== 'GET' && method !== 'HEAD';
  const h = {};
  for (const [k, v] of Object.entries(headers)) if (v != null && v !== '') h[k] = String(v);
  // 本文の種類が書かれていないと、iOS の CapacitorHttp は本文を送らない
  if (hasBody && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/octet-stream';

  // 取り消しは最初から見張る(本文の用意の途中で取り消されても気づくように)
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      plugin('DavHttp')?.cancel?.({ id }).catch(() => {});
      reject(abortError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    const run = platform === 'android' && plugin('DavHttp')
      ? androidRequest(id, url, method, h, hasBody ? body : null, idleTimeout, signal)
      : iosRequest(url, method, h, hasBody ? body : null, idleTimeout, signal);
    return await Promise.race([run, aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

const noBodyStatus = (status, method) => status === 204 || status === 205 || status === 304 || method === 'HEAD';

async function androidRequest(id, url, method, headers, body, idleTimeout, signal) {
  const dav = plugin('DavHttp');
  const blob = body == null ? null : body instanceof Blob ? body : new Blob([body]);
  try {
    if (blob) {
      for (let off = 0; off === 0 || off < blob.size; off += CHUNK) {
        if (signal?.aborted) throw abortError();
        await dav.writeChunk({ id, data: await toBase64(blob.slice(off, off + CHUNK)), append: off > 0 });
      }
    }
    if (signal?.aborted) throw abortError();
    const r = await dav.request({ id, url, method, headers, bodyFile: !!blob, bodySize: blob ? blob.size : -1, idleTimeout }).catch(nativeError);
    let data = null;
    if (!noBodyStatus(r.status, method) && r.size > 0) {
      // 受け取った本文はファイルにある。画面からはファイルの URL で読む(base64 を通さない)
      const f = await fetch(cap.convertFileSrc(r.file));
      data = await f.blob();
      if (!f.ok || data.size !== r.size) throw new TypeError('受け取った本文を読めませんでした');
    }
    return new Response(data, { status: r.status, headers: cleanHeaders(r.headers || {}) });
  } finally {
    dav.remove({ id }).catch(() => {});
  }
}

async function iosRequest(url, method, headers, body, idleTimeout, signal) {
  const http = plugin('CapacitorHttp');
  if (!http) throw new TypeError('この端末では通信の機能が見つかりません');
  const b64 = body != null ? await toBase64(body) : null;
  if (signal?.aborted) throw abortError();
  const r = await http.request({
    url, method, headers,
    ...(b64 != null ? { data: b64, dataType: 'file' } : {}),
    responseType: 'arraybuffer', connectTimeout: idleTimeout, readTimeout: idleTimeout,
  }).catch(nativeError);
  const rh = r.headers || {};
  const data = noBodyStatus(r.status, method) ? null : nativeData(r.data, rh);
  return new Response(data, { status: r.status, headers: cleanHeaders(rh) });
}

function abortError() {
  return new DOMException('取り消しました', 'AbortError');
}

// プラグインの失敗を fetch と同じ形にする。iOS は時間切れでも code が NSURLErrorDomain で、
// 文言は端末の言語で変わる
function nativeError(e) {
  const code = e?.code || '';
  const msg = e?.message || '';
  if (code === 'TIMEOUT' || code === 'CANCELED' || (platform === 'ios' && /timed out|タイムアウト/i.test(msg))) throw abortError();
  throw new TypeError(msg || '通信できませんでした');
}

// iOS の CapacitorHttp は、頼んだ形(arraybuffer → base64)に関係なく、Content-Type が JSON の応答は
// 読み解いた値で返す(読み解けないときはエラーの文言の文字列)。ほかは base64 の文字列
function nativeData(d, headers) {
  if (d == null || d === '') return new Uint8Array(0);
  const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (/json/i.test(type)) return new TextEncoder().encode(typeof d === 'string' ? d : JSON.stringify(d));
  if (typeof d === 'string') {
    try { return fromBase64(d); } catch { return new TextEncoder().encode(d); }
  }
  return new TextEncoder().encode(JSON.stringify(d));
}

// Headers が受け付けない名前(HTTP/2 の :status など)や値を捨てる
function cleanHeaders(obj) {
  const out = new Headers();
  for (const [k, v] of Object.entries(obj)) {
    try { out.append(k, String(v)); } catch { /* 使えない見出しは捨てる */ }
  }
  return out;
}

export async function toBase64(data) {
  const bytes = new Uint8Array(await (data instanceof Blob ? data : new Blob([data])).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(/\s/.test(b64) ? b64.replace(/\s+/g, '') : b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- ファイルの書き出し ----------------------------------------------------
// アプリの WebView では <a download> が何もしないので、いったん端末のキャッシュに書いてから渡す。
//   Android: 保存先を選ぶ画面(「ダウンロード」・Google ドライブなど)。共有シートには「端末に保存」がないことが多い
//   iOS:     共有シート(「"ファイル"に保存」・AirDrop など)
// 戻り値: 'saved'(保存した・渡した) / 'cancelled'(選ぶ画面を閉じた)。失敗は例外
let saving = false;
export async function saveFile(blob, name, type = blob.type || 'application/octet-stream') {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'saved';
  }
  const fs = plugin('Filesystem');
  const save = platform === 'android' ? plugin('SaveFile') : plugin('Share');
  if (!fs || !save) throw new Error('この端末ではファイルを書き出せません');
  if (saving) throw new Error('前の書き出しがまだ終わっていません');
  saving = true;
  try {
    // 前に書き出したファイルは、もう渡し終えているので消す(キャッシュにたまらないように)
    await fs.rmdir({ path: 'export', directory: 'CACHE', recursive: true }).catch(() => {});
    // 大きなファイルでも一度に渡さず、少しずつ書き足す
    let uri = '';
    for (let off = 0; off === 0 || off < blob.size; off += CHUNK) {
      const data = await toBase64(blob.slice(off, off + CHUNK));
      if (off === 0) ({ uri } = await fs.writeFile({ path: `export/${name}`, data, directory: 'CACHE', recursive: true }));
      else await fs.appendFile({ path: `export/${name}`, data, directory: 'CACHE' });
    }
    if (platform === 'android') {
      try {
        const r = await save.save({ path: uri, name, mime: type });
        return r?.saved ? 'saved' : 'cancelled';
      } catch (e) {
        // 保存先を選ぶ画面がない端末では、共有シートで渡す
        if (e?.code !== 'NO_PICKER' || !plugin('Share')) throw e;
      }
    }
    try {
      await plugin('Share').share({ title: name, files: [uri] });
      return 'saved';
    } catch (e) {
      if (/cancel/i.test(e?.message || '')) return 'cancelled'; // 共有シートを閉じただけ
      console.warn(e);
      throw new Error('共有できませんでした');
    }
  } finally {
    saving = false;
  }
}

// ---- Android の「戻る」 -----------------------------------------------------
// 何もしないと、本棚で「戻る」を押したときにダイアログが開いていてもアプリが閉じてしまう。
// 開いているものを内側から順に閉じ、何もなければアプリを裏に回す(閉じない)。
// back(): 閉じるものがあれば閉じて true を返す関数
export function onBackButton(back) {
  const app = plugin('App');
  if (!app || platform !== 'android') return;
  app.addListener('backButton', () => {
    if (back()) return;
    app.minimizeApp().catch(() => {});
  });
}
