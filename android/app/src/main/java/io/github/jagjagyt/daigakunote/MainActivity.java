package io.github.jagjagyt.daigakunote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // このアプリ専用のプラグインは super.onCreate より前に登録する
        registerPlugin(DavHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
