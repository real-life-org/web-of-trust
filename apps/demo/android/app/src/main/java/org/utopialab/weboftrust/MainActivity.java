package org.utopialab.weboftrust;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricKeystorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
