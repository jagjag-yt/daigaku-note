package io.github.jagjagyt.daigakunote;

import android.text.TextUtils;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
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
 * request({ id, url, method, headers, body(base64 か null), idleTimeout(ミリ秒) })
 *   → { status, headers, body(base64) }
 *   失敗: code が "TIMEOUT"(何も届かない時間が idleTimeout を超えた)・"CANCELED"(cancel された)・"NETWORK"
 * cancel({ id }) … 送っている途中の request を取り消す
 */
@CapacitorPlugin(name = "DavHttp")
public class DavHttpPlugin extends Plugin {

    private static final int DEFAULT_IDLE_MS = 60_000;
    private OkHttpClient client;
    private final Map<String, Call> calls = new ConcurrentHashMap<>();

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .connectTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .readTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(DEFAULT_IDLE_MS, TimeUnit.MILLISECONDS)
            .build();
    }

    @PluginMethod
    public void request(final PluginCall call) {
        final String url = call.getString("url");
        final String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        final String id = call.getString("id", "");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String bodyB64 = call.getString("body");
        final int idle = call.getInt("idleTimeout", DEFAULT_IDLE_MS);

        final Request req;
        try {
            Request.Builder rb = new Request.Builder().url(url == null ? "" : url);
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
                // PUT などは本文が必須。本文のない MKCOL・DELETE も長さ0の本文で送れる
                byte[] bytes = bodyB64 == null || bodyB64.isEmpty() ? new byte[0] : Base64.decode(bodyB64, Base64.DEFAULT);
                body = RequestBody.create(bytes, contentType == null ? null : MediaType.parse(contentType));
            }
            rb.method(method, body);
            req = rb.build();
        } catch (IllegalArgumentException e) {
            // URL やヘッダーの書き方がおかしい
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
        if (!id.isEmpty()) calls.put(id, okCall);
        okCall.enqueue(
            new Callback() {
                @Override
                public void onFailure(Call cl, IOException e) {
                    if (!id.isEmpty()) calls.remove(id);
                    if (cl.isCanceled()) call.reject("取り消しました", "CANCELED");
                    else if (e instanceof InterruptedIOException) call.reject("時間切れ", "TIMEOUT");
                    else call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "NETWORK");
                }

                @Override
                public void onResponse(Call cl, Response res) {
                    try (ResponseBody rbody = res.body()) {
                        byte[] bytes = rbody == null ? new byte[0] : rbody.bytes();
                        JSObject h = new JSObject();
                        for (String name : res.headers().names()) {
                            List<String> values = res.headers(name);
                            h.put(name, TextUtils.join(", ", values));
                        }
                        JSObject out = new JSObject();
                        out.put("status", res.code());
                        out.put("headers", h);
                        out.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        call.resolve(out);
                    } catch (IOException e) {
                        if (cl.isCanceled()) call.reject("取り消しました", "CANCELED");
                        else if (e instanceof InterruptedIOException) call.reject("時間切れ", "TIMEOUT");
                        else call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "NETWORK");
                    } finally {
                        if (!id.isEmpty()) calls.remove(id);
                    }
                }
            }
        );
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
