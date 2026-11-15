package day.kolibri.client;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before the bridge starts, or the bundle
        // asks for one that is not there yet. See AppPushPlugin for why it exists.
        registerPlugin(AppPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
