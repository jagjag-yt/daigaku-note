// アプリ版(Android / iOS、Capacitor)とブラウザ版の違いをここにまとめる。
// ブラウザでは何もしない(fetch・<a download> をそのまま使う)。
//
// Capacitor は @capacitor/core を import しなくても、起動時に window.Capacitor と
// Capacitor.Plugins.<名前> を用意してくれるので、ビルド(バンドル)なしのまま使える。

const cap = globalThis.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
export const platform = isNative ? cap.getPlatform() : 'web';
const plugin = (name) => (isNative ? cap.Plugins?.[name] : undefined);

// ---- 通信 -----------------------------------------------------------------
// アプリの画面は https://localhost(Android)/ capacitor://localhost(iOS)から開くので、
// WebDAV サーバーへの fetch はブラウザと同じく CORS で止められる。
// アプリでは OS の通信機能を直接使い、CORS を通らないようにする。
//   Android: このアプリ専用のプラグイン DavHttp(PROPFIND・MKCOL を送れる。Capacitor 標準の
//            CapacitorHttp は Java の HttpURLConnection を使うので、この2つを送れない)
//   iOS:     Capacitor 標準の CapacitorHttp(URLSession はどんなメソッドでも送れる)
//
// 戻り値は fetch と同じ Response。失敗の形も fetch に合わせる:
//   つながらない → TypeError、取り消し・時間切れ → name が 'AbortError' のエラー
// idleTimeout: 何も届かない(送れない)時間がこれを超えたら時間切れ(ミリ秒)。アプリ版だけが使う。
//   ブラウザ版では呼ぶ側が signal で時間切れを作る。
let reqSeq = 0;
export async function http(url, { method = 'GET', body = null, headers = {}, signal, idleTimeout = 60_000 } = {}) {
  if (!isNative) return fetch(url, { method, body, headers, cache: 'no-store', signal });
  if (signal?.aborted) throw abortError();
  const hasBody = body != null && method !== 'GET' && method !== 'HEAD';
  const h = { ...headers };
  // 本文の種類が書かれていないと、iOS の CapacitorHttp は本文を送らない
  if (hasBody && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/octet-stream';
  const b64 = hasBody ? await toBase64(body) : null;
  const id = `r${Date.now().toString(36)}-${++reqSeq}`;

  let call;
  if (platform === 'android' && plugin('DavHttp')) {
    call = plugin('DavHttp').request({ id, url, method, headers: h, body: b64, idleTimeout })
      .then((r) => ({ status: r.status, headers: r.headers || {}, bytes: fromBase64(r.body || '') }));
  } else if (plugin('CapacitorHttp')) {
    call = plugin('CapacitorHttp').request({
      url, method, headers: h,
      ...(hasBody ? { data: b64, dataType: 'file' } : {}),
      responseType: 'arraybuffer', connectTimeout: idleTimeout, readTimeout: idleTimeout,
    }).then((r) => ({ status: r.status, headers: r.headers || {}, bytes: nativeData(r.data) }));
  } else {
    throw new TypeError('この端末では通信の機能が見つかりません');
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      plugin('DavHttp')?.cancel?.({ id }).catch(() => {});
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const r = await Promise.race([call.catch(nativeError), aborted]);
    const noBody = r.status === 204 || r.status === 205 || r.status === 304 || method === 'HEAD';
    return new Response(noBody ? null : r.bytes, { status: r.status, headers: cleanHeaders(r.headers) });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function abortError() {
  return new DOMException('取り消しました', 'AbortError');
}

// プラグインの失敗を fetch と同じ形にする
function nativeError(e) {
  const code = e?.code || '';
  if (code === 'TIMEOUT' || code === 'CANCELED' || /timed? ?out/i.test(e?.message || '')) throw abortError();
  throw new TypeError(e?.message || '通信できませんでした');
}

// CapacitorHttp は Content-Type が JSON の応答を、頼んだ形(arraybuffer)に関係なく
// 読み解いたオブジェクトで返してくる。文字のバイト列に戻す
function nativeData(d) {
  if (d == null) return new Uint8Array(0);
  if (typeof d === 'string') return fromBase64(d);
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
  const s = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- ファイルの書き出し ----------------------------------------------------
// アプリの WebView では <a download> が何もしないので、いったん端末のキャッシュに書いてから
// 共有シート(「ファイルに保存」・Google ドライブ・メールなど)で渡す。
// 戻り値: 渡せた / ブラウザで保存した → true、共有シートを閉じた → false
export async function saveFile(blob, name) {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
  const fs = plugin('Filesystem'), share = plugin('Share');
  if (!fs || !share) throw new Error('この端末ではファイルを書き出せません');
  const { uri } = await fs.writeFile({ path: `export/${name}`, data: await toBase64(blob), directory: 'CACHE', recursive: true });
  try {
    await share.share({ title: name, files: [uri], dialogTitle: name });
    return true;
  } catch (e) {
    if (/cancel/i.test(e?.message || '')) return false; // 共有シートを閉じただけ
    throw e;
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
