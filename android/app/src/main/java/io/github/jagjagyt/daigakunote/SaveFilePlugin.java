package io.github.jagjagyt.daigakunote;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 書き出したファイル(PDF・同期ファイル)を、保存先を選ぶ画面(「ダウンロード」・Google ドライブなど)で保存する。
 * Android の共有シートには「端末に保存」がないことが多いので、こちらを使う。
 *
 * save({ path(キャッシュに書いたファイルの場所), name, mime }) → { saved: true / false(選ぶ画面を閉じた) }
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name", "file");
        String mime = call.getString("mime", "application/octet-stream");
        String path = call.getString("path");
        if (path == null || !fileOf(path).exists()) {
            call.reject("書き出すファイルが見つかりません");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saved");
    }

    // "file:///data/.../cache/export/a.pdf" でも "/data/.../a.pdf" でも受け付ける
    private static File fileOf(String path) {
        String p = path.startsWith("file:") ? Uri.parse(path).getPath() : path;
        return new File(p == null ? path : p);
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject out = new JSObject();
            out.put("saved", false);
            call.resolve(out);
            return;
        }
        final Uri dest = data.getData();
        final String path = call.getString("path");
        final File src = fileOf(path);
        // 大きなファイルでも画面が止まらないように、別のスレッドで書き写す
        new Thread(() -> {
            try (
                InputStream in = new FileInputStream(src);
                OutputStream os = getContext().getContentResolver().openOutputStream(dest, "wt")
            ) {
                if (os == null) throw new java.io.IOException("保存先を開けません");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
                JSObject out = new JSObject();
                out.put("saved", true);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("保存できませんでした: " + e.getMessage());
            }
        }).start();
    }
}
