package io.github.jagjagyt.daigakunote;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * WebDAV 同期のための通信(js/native.js の http() から使う)。
 *
 * アプリの画面(https://localhost)からの fetch はサーバーの CORS 設定に左右されるので、OS 側で通信する。
 * Capacitor 標準の CapacitorHttp は HttpURLConnection を使っていて PROPFIND・MKCOL を送れないため、
 * どんなメソッドでも送れる OkHttp を使う。
 *
 * 大きな PDF でもメモリが足りなくならないように、本文は画面とのあいだでまとめて渡さず、
 * キャッシュのフォルダ(cache/davhttp/)のファイルを通す。
 *   writeChunk({ id, data(base64), append }) … 送る本文を少しずつファイルに書く(<id>.up)
 *   request({ id, url, method, headers, bodyFile(true なら <id>.up を送る), idleTimeout(ミリ秒) })
 *     → { status, headers, file(受け取った本文のファイルの場所 <id>.down), size }
 *     失敗: code が "TIMEOUT"(何も届かない時間が idleTimeout を超えた)・"CANCELED"(cancel された)・"NETWORK"
 *   remove({ id }) … 画面が読み終えた <id>.down を消す
 *   cancel({ id }) … 送っている途中の request を取り消す
 * リダイレクト(3xx)は追いかけずにそのまま返す。OkHttp は 301・302 で PUT や MKCOL を GET に変えて
 * 追いかけるので、「送れたことになったのに届いていない」が起きるため。
 */
@CapacitorPlugin(name = "DavHttp")
public class DavHttpPlugin extends Plugin {

    private static final int DEFAULT_IDLE_MS = 60_000;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    private OkHttpClient client;
    private File dir;
    private final Map<String, Call> calls = new ConcurrentHashMap<>();

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .connectTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .readTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();
        dir = new File(getContext().getCacheDir(), "davhttp");
        // 前に起動したときの残り(途中で落ちたときなど)を消す
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        dir.mkdirs();
    }

    private String idOf(PluginCall call) {
        String id = call.getString("id", "");
        if (!ID.matcher(id).matches()) {
            call.reject("id が正しくありません", "NETWORK");
            return null;
        }
        return id;
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String id = idOf(call);
        if (id == null) return;
        String data = call.getString("data", "");
        boolean append = call.getBoolean("append", false);
        try (OutputStream os = new FileOutputStream(new File(dir, id + ".up"), append)) {
            os.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (IOException | IllegalArgumentException e) {
            call.reject("送る本文を用意できませんでした: " + e.getMessage(), "NETWORK");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = idOf(call);
        if (id == null) return;
        new File(dir, id + ".up").delete();
        new File(dir, id + ".down").delete();
        call.resolve();
    }

    @PluginMethod
    public void request(final PluginCall call) {
        final String id = idOf(call);
        if (id == null) return;
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        final JSObject headers = call.getObject("headers", new JSObject());
        final boolean bodyFile = call.getBoolean("bodyFile", false);
        final int idle = call.getInt("idleTimeout", DEFAULT_IDLE_MS);
        final File up = new File(dir, id + ".up");
        final File down = new File(dir, id + ".down");

        final Request req;
        try {
            Request.Builder rb = new Request.Builder().url(url);
            String contentType = null;
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = headers.getString(k);
                if (v == null) continue;
                if (k.equalsIgnoreCase("Content-Type")) contentType = v;
                rb.header(k, v);
            }
            RequestBody body = null;
            if (!method.equals("GET") && !method.equals("HEAD")) {
                MediaType mt = contentType == null ? null : MediaType.parse(contentType);
                // PUT などは本文が必須。本文のない MKCOL・DELETE も長さ0の本文で送る
                body = bodyFile && up.exists() ? RequestBody.create(up, mt) : RequestBody.create(new byte[0], mt);
            }
            rb.method(method, body);
            req = rb.build();
        } catch (IllegalArgumentException e) {
            // URL やヘッダーの書き方がおかしい
            up.delete();
            call.reject("送れない要求です: " + e.getMessage(), "NETWORK");
            return;
        }

        OkHttpClient c = idle == DEFAULT_IDLE_MS
            ? client
            : client
                .newBuilder()
                .connectTimeout(idle, TimeUnit.MILLISECONDS)
                .readTimeout(idle, TimeUnit.MILLISECONDS)
                .writeTimeout(idle, TimeUnit.MILLISECONDS)
                .build();
        final Call okCall = c.newCall(req);
        calls.put(id, okCall);
        okCall.enqueue(
            new Callback() {
                @Override
                public void onFailure(Call cl, IOException e) {
                    calls.remove(id);
                    up.delete();
                    fail(call, cl, e);
                }

                @Override
                public void onResponse(Call cl, Response res) {
                    long size = 0;
                    // 本文はメモリに読み込まず、ファイルに流し込む
                    try (ResponseBody rbody = res.body(); OutputStream os = new FileOutputStream(down)) {
                        if (rbody != null && !method.equals("HEAD")) {
                            InputStream in = rbody.byteStream();
                            byte[] buf = new byte[64 * 1024];
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                os.write(buf, 0, n);
                                size += n;
                            }
                        }
                        JSObject h = new JSObject();
                        for (String name : res.headers().names()) {
                            h.put(name, android.text.TextUtils.join(", ", res.headers(name)));
                        }
                        JSObject out = new JSObject();
                        out.put("status", res.code());
                        out.put("headers", h);
                        out.put("file", down.getAbsolutePath());
                        out.put("size", size);
                        call.resolve(out);
                    } catch (IOException e) {
                        down.delete();
                        fail(call, cl, e);
                    } catch (Throwable e) {
                        // 思わぬ失敗でも、画面の側を待たせたままにしない
                        down.delete();
                        call.reject("受け取りに失敗しました: " + e, "NETWORK");
                    } finally {
                        calls.remove(id);
                        up.delete();
                    }
                }
            }
        );
    }

    private static void fail(PluginCall call, Call cl, IOException e) {
        if (cl.isCanceled()) call.reject("取り消しました", "CANCELED");
        else if (e instanceof InterruptedIOException) call.reject("時間切れ", "TIMEOUT");
        else call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "NETWORK");
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Call c = calls.remove(call.getString("id", ""));
        if (c != null) c.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Call c : calls.values()) c.cancel();
        calls.clear();
    }
}
