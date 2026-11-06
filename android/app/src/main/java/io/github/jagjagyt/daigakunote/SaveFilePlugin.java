package io.github.jagjagyt.daigakunote;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
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
        try {
            startActivityForResult(call, intent, "saved");
        } catch (ActivityNotFoundException e) {
            // 保存先を選ぶ画面がない端末(画面の側で共有シートに切り替える)。
            // startActivityForResult が先に call を預けているので、返してから断る
            getBridge().releaseCall(call);
            call.reject("保存先を選ぶ画面がありません", "NO_PICKER");
        }
    }

    // "file:///data/.../cache/export/a.pdf" でも "/data/.../a.pdf" でも受け付ける
    private static File fileOf(String path) {
        String p = path.startsWith("file:") ? Uri.parse(path).getPath() : path;
        return new File(p == null ? path : p);
    }

    // "wt"(中身を切り詰めて書く)で開く。対応していない保存先だけ "w" にする
    // (Android 10 以降、"w" では前の中身が後ろに残ることがあるため)
    private OutputStream openForWrite(Uri dest) throws java.io.IOException {
        try {
            return getContext().getContentResolver().openOutputStream(dest, "wt");
        } catch (IllegalArgumentException | UnsupportedOperationException | java.io.FileNotFoundException e) {
            return getContext().getContentResolver().openOutputStream(dest, "w");
        }
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        if (call == null) return;
        // 預けた call を返す(返さないと保存のたびに溜まる。手元の参照で resolve / reject はできる)
        getBridge().releaseCall(call);
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
                OutputStream os = openForWrite(dest)
            ) {
                if (os == null) throw new java.io.IOException("保存先を開けません");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
                JSObject out = new JSObject();
                out.put("saved", true);
                call.resolve(out);
            } catch (Exception e) {
                // 選んだ時点で空のファイルができているので、書けなかったら消しておく
                try {
                    DocumentsContract.deleteDocument(getContext().getContentResolver(), dest);
                } catch (Exception ignored) {}
                call.reject("保存できませんでした: " + e.getMessage());
            }
        }).start();
    }
}
