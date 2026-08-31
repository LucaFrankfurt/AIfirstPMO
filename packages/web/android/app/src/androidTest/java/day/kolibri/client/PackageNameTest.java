package day.kolibri.client;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The one thing worth asserting on a device before there is anything to assert.
 *
 * The template shipped this test asserting `com.getcapacitor.app`, which was
 * never this app's name — it would have failed the first time anybody ran it,
 * and said nothing about Kolibri when it did.
 *
 * `startsWith` rather than equals, because `build.gradle` gives the debug
 * variant an `applicationIdSuffix` so it can sit beside a store build, and this
 * runs against the debug variant.
 */
@RunWith(AndroidJUnit4.class)
public class PackageNameTest {

    @Test
    public void theAppIsTheOneThisRepositoryNames() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(appContext.getPackageName().startsWith("day.kolibri.client"));
    }
}
