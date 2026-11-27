package io.github.nathanaelp.bikecommuter;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the screen on while navigating, like Google Maps does. The web Screen
 * Wake Lock API is not available inside Android's WebView, so the page calls
 * this instead (see keepAwake() in app.js).
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    @PluginMethod
    public void keepAwake(PluginCall call) {
        setFlag(true);
        call.resolve();
    }

    @PluginMethod
    public void allowSleep(PluginCall call) {
        setFlag(false);
        call.resolve();
    }

    private void setFlag(boolean on) {
        getActivity().runOnUiThread(() -> {
            if (on) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }
}
