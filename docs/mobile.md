# The app on a phone

Kolibri ships to the App Store and Google Play as a [Capacitor](https://capacitorjs.com) shell
around the same bundle a browser gets. There is no second client: `capacitor.config.ts` points
`webDir` at `packages/web/dist`, so a screen fixed once is fixed everywhere, and what the shell adds
is a store listing, an icon on a home screen and — later — a push token the web has no way to hold.

The native projects are in the tree, beside the client they wrap:

```
packages/web/capacitor.config.ts   what both platforms read
packages/web/ios/                  the Xcode project
packages/web/android/              the Gradle project
```

They are committed rather than generated on demand. `cap add` writes a project from a template and
then never touches it again — every signing certificate, entitlement and `Info.plist` key after that
is yours, so regenerating would throw away the work rather than reproduce it.

## Building one

```bash
npm run mobile            # build the web bundle, copy it into both projects
npm run mobile:ios        # open Xcode
npm run mobile:android    # open Android Studio
```

`npm run mobile` is `vite build && cap sync`. Run it after **every** change to the client — the
native projects hold a *copy* of `dist`, and a build that skips it ships the previous one.

From there it is each platform's own workflow: a signing team and a device in Xcode, a run
configuration in Android Studio. Neither is scriptable from this repository, and neither is checked
by CI — the smoke walk exercises the client in a browser at a phone's viewport, which is the part
that can be automated.

## Why the app asks for an address

A packaged app does not load from the server. iOS serves the bundle from `capacitor://localhost` and
Android from `https://localhost`, so:

- a relative `/api/…` addresses the app's own bundle rather than a Kolibri, and
- the session cookie belongs to the server's origin and is never sent.

Both are answered in `packages/web/src/kernel/sync/server.ts`. The app asks once where its server is,
keeps the answer, and signs in with `x-kolibri-client: native` — which is what makes the server hand
back the session token in the response body instead of only setting the cookie. Every request after
that carries it as `Authorization: Bearer`. A browser does none of this: its origin *is* the server,
its cookie stays `HttpOnly`, and the header is never sent. See [`security.md`](security.md) for what
that second credential path costs and why it is narrow.

## HTTPS, and the one exception

The address you give the app is where a bearer token goes, so both platforms refuse plain HTTP by
default and this repository leaves that alone. A Kolibri reachable from a phone needs TLS — which the
compose files already do for you.

The exception is development, where the server is a laptop on the same wifi:

- **Android** permits cleartext in the `debug` variant only
  (`app/src/debug/AndroidManifest.xml`). The variant that goes to a store does not.
- **iOS** sets `NSAllowsLocalNetworking`, which lifts ATS for `.local` names, unqualified hostnames
  and the private address ranges while leaving every public host behind it. Nobody has run this
  against a numeric address from a device, so treat it as untested.

## The two identifiers

The app is `day.kolibri.client` on both stores — reverse-DNS of a domain that is ours, and `client`
because the identifier names *this program* rather than the product: a server, an agent or a second
app would each want their own name. It is immutable once either store has seen it; Apple and Google
both key identity, signing and purchase history off that string, and a new one is a new app with no
users.

The Android `debug` variant is `day.kolibri.client.dev`, labelled "Kolibri dev" and claiming its own
URL scheme. An installed Android app is keyed by its `applicationId` and nothing else, so without the
suffix a debug build would replace a store build on the same phone and take its database with it.

## What is not done

- **Push.** The server already has the port (`notify.onNotification`) and the web has a service
  worker behind it, but neither web push in an Android WebView nor a service worker under
  `capacitor://` delivers anything. Native push means an FCM and an APNs adapter filling that same
  port, and credentials this repository does not have.
- **Store listings.** No screenshots, no privacy manifest, no `PrivacyInfo.xcprivacy`, no App Store
  or Play Console entry.
- **Anything measured on a device.** Every claim here about how a WebView behaves was reasoned from
  the platform's documentation and the client's own code. The client half was verified across a real
  origin boundary — the bundle on one port, the API on another, `window.Capacitor` present, at a
  phone's viewport — and that is not the same as a phone.
