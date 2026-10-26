package org.reallife.weboftrust;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the app's own plugins (src/platform/capacitor); the npm plugins register through cap sync
        registerPlugin(BiometricKeystorePlugin.class);
        registerPlugin(ScreenProtectionPlugin.class);
        registerPlugin(AppSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
