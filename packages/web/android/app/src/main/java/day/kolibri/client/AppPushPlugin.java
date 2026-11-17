package day.kolibri.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether this build can receive a push at all — asked before the push plugin
 * is.
 *
 * Firebase is configured at build time, from `google-services.json`, and a
 * build without that file has no Firebase in it. The push plugin does not ask:
 * its `register()` calls `FirebaseMessaging.getInstance()`, which throws when
 * Firebase was never set up, and Capacitor rethrows a plugin's exception on the
 * main thread — so tapping "turn on notifications" in such a build ended the
 * app. The client asks this first and offers no switch when the answer is no.
 *
 * The test is the one Firebase makes for itself at start-up: the Google Services
 * Gradle plugin writes `google_app_id` into the app's resources, and without it
 * Firebase does not initialise. No Firebase class is touched here, because the
 * push plugin depends on Firebase privately and this module cannot see it.
 */
@CapacitorPlugin(name = "AppPush")
public class AppPushPlugin extends Plugin {

    @PluginMethod
    public void available(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("available", id != 0);
        call.resolve(result);
    }
}
