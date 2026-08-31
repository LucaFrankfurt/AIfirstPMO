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

## The icons

Both shells shipped with Capacitor's own mark on them. They now come off the same
source art as everything else — `python3 scripts/brand.py` writes the favicon, the
PWA icons, the two native launcher sets and both launch screens from
`assets/brand/kolibri-logo-outline.svg`, so the app's mark cannot drift between
the web and a phone by having been re-run in only one place.

Each platform masks an icon to a circle of its own size, and the script derives
one fill ratio per case from a single rule rather than keeping three numbers: a
square inscribed in a circle of diameter `d` has side `d / sqrt(2)`, and the
silhouette's empty corners buy a little past that. Asked with the PWA's 80% it
reproduces the ratio that was already there by eye, which is the reason to trust
it for Android's 66.7% and for a full circle.

Re-running the script needs Pillow (`pip install pillow`). It rewrites every icon
in the repository, and PNG bytes differ between Pillow versions even when the
pixels do not — so check `git diff` for files you did not mean to change.

## The two identifiers

The app is `day.kolibri.client` on both stores — reverse-DNS of a domain that is ours, and `client`
because the identifier names *this program* rather than the product: a server, an agent or a second
app would each want their own name. It is immutable once either store has seen it; Apple and Google
both key identity, signing and purchase history off that string, and a new one is a new app with no
users.

The Android `debug` variant is `day.kolibri.client.dev`, labelled "Kolibri dev" and claiming its own
URL scheme. An installed Android app is keyed by its `applicationId` and nothing else, so without the
suffix a debug build would replace a store build on the same phone and take its database with it.

## The open question: uploaded files do not load

**This is the one thing that stops the app being usable, and it is a decision rather than a
repair.** No attachment, avatar, page cover or pasted screenshot renders in a packaged app.

Measured against a seeded server, uploading a file the way the client does:

```
server returns:  /files/<hash>/px.png     ← root-relative
  bare GET         401     ← what an <img> sends: no cookie (cross-origin), no header (an image
                              cannot set one)
  Authorization    200     ← what an <img> cannot send
  ?access_token    200
```

Two things go wrong at once. The URL the server stores and returns is root-relative, so in a
packaged app it addresses the app's own bundle rather than a Kolibri; and `/files/:hash` requires
authentication, which an `<img>`, a CSS `url()` and a `<link>` have no way to supply. Six places
render one: `TaskDetail`, `page-parts`, `Avatar` in `ui.tsx`, and the markdown renderer in
`@kolibri/shared`, which is what comments, chat and page bodies all go through.

`authenticate` accepts `?access_token=` on every route, not only on SSE — so a query token is the
only mechanism that makes an `<img>` load, and that is the whole difficulty:

| | |
|---|---|
| **Token in the query** | Works everywhere with one helper. But the session token then sits in the DOM, in `document.referrer`, and in the server's access log — and the "open original" link carries `target="_blank"`, which on a phone hands that token to the system browser. |
| **`fetch` + a `blob:` URL** | Nothing leaves the WebView. But an image is no longer a URL, so the markdown renderer's raw HTML needs a pass over the rendered subtree, and the bytes sit in memory. |
| **A short-lived file ticket** | A second token, read-only and expiring in a minute. Still a token in a URL, but a narrow one — and it is a new endpoint, a new table and a new thing to revoke. |

The shape that seems right, and is not yet agreed: a query token for `<img>` and CSS `url()`, where
the URL never leaves the WebView and SSE already set the precedent — and `fetch` + `blob:` for the
anchors that open a file, so nothing ever hands a session token to an external browser. Whichever
way it goes, it is one helper in `kernel/sync/server.ts` plus an option on `MarkdownOptions`, so
`@kolibri/shared` keeps knowing nothing about origins.

## What is not done

- **Push.** The server already has the port (`notify.onNotification`) and the web has a service
  worker behind it, but neither web push in an Android WebView nor a service worker under
  `capacitor://` delivers anything. Native push means an FCM and an APNs adapter filling that same
  port, and credentials this repository does not have.
- **SSO.** `ssoHref` is root-relative, and the provider redirects back to the *server's* origin —
  which the app is not. Making OIDC work in the shell means a registered deep link and a redirect
  target that reaches it; the app ID already claims a URL scheme, and nothing listens on it yet.
- **Store listings.** No screenshots, no privacy manifest, no `PrivacyInfo.xcprivacy`, no App Store
  or Play Console entry.
- **Anything measured on a device.** Every claim here about how a WebView behaves was reasoned from
  the platform's documentation and the client's own code. The client half was verified across a real
  origin boundary — the bundle on one port, the API on another, `window.Capacitor` present, at a
  phone's viewport — and that is not the same as a phone. Specifically unmeasured:

  - Whether `NSAllowsLocalNetworking` reaches a numeric `http://192.168.x.x` address on iOS.
  - How large the adaptive icon looks in a launcher. Its fill is derived conservatively, from the
    circle Android *guarantees* rather than the one a launcher usually shows, so it may read small
    beside other apps. One number in `brand.py`, with the trade-off written beside it.
  - Whether the launch screen hands over to the app without a flash. Splash, WebView ground and the
    web manifest are all `#0b0d12`, so a dark-mode start should be one colour throughout and a
    light-mode one should change once at the end — but nobody has watched it happen.

- **`npm audit` reports three moderate advisories**, all one thing: `uuid` below 11.1.1, reached
  through `xcode`, reached through `@capacitor/cli`. A build-time devDependency that writes the
  `.pbxproj`; nothing in it ships. The offered fix downgrades the CLI, which costs more than the
  advisory does.
