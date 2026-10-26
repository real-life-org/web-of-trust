package org.reallife.weboftrust;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the app's page in the system settings (src/platform/capacitor/scanner.ts openAppSettings):
 * page "app" the app details (permissions), page "language" the per-app language on Android 13+
 * (the app details below that).
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String page = call.getString("page", "app");
        Uri pkg = Uri.fromParts("package", getContext().getPackageName(), null);
        Intent intent;
        if ("language".equals(page) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent = new Intent(Settings.ACTION_APP_LOCALE_SETTINGS, pkg);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No settings page: " + e.getMessage(), "UNAVAILABLE");
        }
    }
}
