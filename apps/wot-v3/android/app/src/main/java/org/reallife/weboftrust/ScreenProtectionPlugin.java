package org.reallife.weboftrust;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Screen protection (architecture §5 table, src/platform/capacitor/index.ts):
 * - setSecure: FLAG_SECURE while a sensitive screen shows (no screenshots, no recording).
 * - setCoverInBackground: no content in the app switcher. Android 13+ turns off the recents
 *   screenshot; below that FLAG_SECURE is set while the app is paused.
 * The event "screenshotTaken" is not sent on Android: FLAG_SECURE already prevents the screenshot on
 * sensitive screens, and Android 14's screen-capture callback would need one more permission.
 */
@CapacitorPlugin(name = "ScreenProtection")
public class ScreenProtectionPlugin extends Plugin {

    private boolean secure = false;
    private boolean cover = false;
    private boolean paused = false;

    @PluginMethod
    public void setSecure(PluginCall call) {
        secure = Boolean.TRUE.equals(call.getBoolean("secure", false));
        apply();
        call.resolve();
    }

    @PluginMethod
    public void setCoverInBackground(PluginCall call) {
        cover = Boolean.TRUE.equals(call.getBoolean("on", false));
        apply();
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        paused = true;
        apply();
    }

    @Override
    protected void handleOnResume() {
        paused = false;
        apply();
    }

    private void apply() {
        Activity activity = getActivity();
        if (activity == null) return;
        boolean recentsShot = !cover;
        boolean flag = secure || (cover && paused && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU);
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.setRecentsScreenshotEnabled(recentsShot);
            }
            if (flag) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
        });
    }
}
