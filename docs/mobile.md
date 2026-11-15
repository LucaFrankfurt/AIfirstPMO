# The app on a phone

Kolibri ships to the App Store and Google Play as a [Capacitor](https://capacitorjs.com) shell
around the same bundle a browser gets. There is no second client: `capacitor.config.ts` points
`webDir` at `packages/web/dist`, so a screen fixed once is fixed everywhere, and what the shell adds
is a store listing, an icon on a home screen and a push token the web has no way to hold — see
[Push](#push).

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

`npm run mobile` is `vite build --sourcemap false && cap sync`. Run it after **every** change to the
client — the native projects hold a *copy* of `dist`, and a build that skips it ships the previous
one. The source maps are left out because they were three quarters of that copy — measured, 19 MB
of the 25 MB that went into each project — and a phone has no devtools to read them with. The
browser build keeps them. The one consequence: `dist` after `npm run mobile` has no maps, so a
server started from it serves none until the next `npm run build`.

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

### The bundle answers every path

Neither shell returns a 404. Capacitor's asset handler — `WebViewLocalServer` on Android, the router
behind `WebViewAssetHandler` on iOS — serves `index.html` with a **200** for any path without an
extension, because that is what a single-page app wants for its own routes. It also means any
request that forgot to go through `serverUrl` does not fail; it succeeds, with HTML.

That shipped as a crash on every fresh install. The session lookup ran before anybody had named a
server, came back from the bundle as a "session" made of HTML, and `session.workspaces.find` put the
app on its error screen before the picker could draw. The picker had the same blind spot: it took
any 200 from `/api/config` as a Kolibri, so the app's own origin, a captive portal or a bare host
typed without `https://` (which stays relative, and so reaches the bundle) were all accepted.

What holds it now:

- the session provider does not ask until there is a server to ask;
- the picker keeps only the origin of what was typed, assumes `https://` when no scheme was given,
  and asks `/api/config` for the two fields every version has sent rather than for a 200;
- `npm run check:packaged` walks the app with the bundle answered exactly that way — the check that
  missed this before served the bundle from a static server that said 404.

Signing out leaves the address; the sign-in screen names the host and has **Change server**, which
forgets the token before the address so it is never sent to the next one.

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

## Uploaded files

Every upload is stored and returned as a root-relative `/files/<hash>/<name>`, behind
authentication. In a browser that is fine — same origin, the cookie goes with it. In the app it
addressed the app's own bundle, and an `<img>`, a CSS `url()` and an anchor cannot carry the bearer
the app signs in with. Measured against a seeded server: a bare GET is 401, `Authorization` is 200,
`?access_token=` is 200. No attachment, avatar, cover or pasted screenshot rendered.

There are now two answers, chosen by what the URL is for (`kernel/sync/server.ts`):

- **Drawn inside the WebView** — images in markdown and HTML pages, avatars, covers, attachment
  thumbnails, conversation pictures — the URL gets the server's origin and the session token in its
  query, the precedent SSE already set. `withFileSources` rewrites rendered markup on its way into
  the DOM; `fileSrc` does the same for the components. The markup that is *stored* keeps saying
  `/files/…`, and the HTML editor strips the rewrite on the way back out
  (`withoutFileSources`), so saving a page never writes a token into it.
- **Opened** — an attachment link, "open the original", a `[report](/files/…)` in a comment — is
  never handed to the system browser. `adapters/native/files.ts` takes the click for the whole
  document, fetches the file with the token in a header, writes it to the app's cache directory and
  hands it to the phone's share sheet, which is where a phone opens a PDF, saves to Files or sends a
  photo on.

`npm run check:packaged` walks both: an uploaded image on a page draws from the server, and tapping
a link to it fetches it with the header while the app stays where it was.

What this costs, said where an operator will look:

- **The token can reach a reverse proxy's access log.** The image URLs carry it in the query, and a
  proxy in front of Kolibri usually logs full URLs. Kolibri's own logs do not. Strip `access_token`
  from the proxy's log format if that matters for your instance.
- **Copying rendered content that contains an image** out of the app into another app's rich-text
  field carries the image's URL, token included.
- **A file being opened is held in memory twice for a moment**, because it crosses the bridge as
  base64. Unmeasured for large files on a real phone.

Nothing here changes a browser: there, every one of these helpers returns its input.

## Exports, backups and saved pages

Every download in the client goes through `kernel/files/save.ts`: `saveFromServer` for what the
server streams (the workspace and project archives, the tasks CSV, the personal export, an instance
backup) and `saveBlob` for what the page builds (a JSON export, a page saved as HTML or markdown).
In a browser they do what the client always did — a hidden frame, so a large archive streams to
disk, and a link with `download`. In the app both used to fail: the frame and the project export's
navigation reached the bundle, which answers `/api/…` with itself, and a `blob:` download is
something neither WebView hands to the system.

The kernel cannot reach the phone, so it declares a port and `adapters/native/files.ts` fills it:

- **From the server**, `@capacitor/file-transfer` downloads natively, straight to a file in the
  app's cache, with the session in a header. Natively because these are the large ones — a backup
  through the page would be held as a blob and then again as base64 to cross the bridge.
- **From the page**, the blob is written to the cache.
- Either way the file goes to the share sheet: "Save to Files", or straight into another app. One
  file is kept at a time; the next download empties the directory first, so a backup does not sit
  in the cache until the operating system gets round to it.

The app names each file itself, the way the server does, because a native download does not hand
back the reply's `Content-Disposition`. `check:packaged` walks the personal export with a recorder
standing where the native bridge would, and checks the calls the app makes: a download of the right
path from the server, with the session, saved under the right name, handed to the share sheet — and
the app left where it was. Whether a real phone's share sheet does the rest is unmeasured.

## Push

Option A of the three that were on the table, chosen for a first release: **the phone is told that
something happened, and nothing about what.** Tapping the banner opens the app on its inbox, which
reads the real notifications from the user's own server with their own session.

Why there is a relay at all: the app in the stores can only be pushed to with its publisher's
credentials — an APNs key from the Apple developer account, a Firebase service account from Google.
Those cannot be given to every server somebody installs. So a server asks a relay that holds them,
the way Nextcloud, Mattermost and Rocket.Chat do it:

```
your Kolibri ──{ phone token, platform, language }──▶ relay ──▶ APNs / FCM ──▶ phone
```

| piece | where | what it does |
|---|---|---|
| server | `adapters/push/app.ts` | keeps each phone's token **tied to the session that registered it** — signing out, or revoking that session from another device, stops the waking; gathers a burst for two seconds into one wake; deletes tokens Apple or Google call gone. `KOLIBRI_PUSH_RELAY`, default `https://push.kolibri.day`; empty turns it off |
| relay | `src/relay.ts`, `adapters/relay/` | zero dependencies; FCM HTTP v1 with a service-account JWT, APNs over HTTP/2 with an ES256 provider token, production first and the sandbox on `BadDeviceToken`. Says one fixed sentence — "New activity" in English, German or French — whatever it is sent. Six wakes per phone per minute. Keeps nothing |
| client | `adapters/push/app.tsx` | the switch in Settings, per device and opt-in; refreshes the token on start; forgets it if the phone was signed out since; routes a tap to the inbox |
| Android | `AppPushPlugin.java`, manifest, `drawable-*/ic_stat_kolibri.png` | answers whether this build has Firebase in it — the push plugin's `register()` ends the app when it does not; the status-bar icon; the default channel |
| iOS | `AppDelegate.swift`, `App.entitlements` | hands the device token to the plugin; the push entitlement |

**What the publisher has to do once**, none of which this repository can:

1. A Firebase project with an Android app `day.kolibri.client` (and `day.kolibri.client.dev` for the
   debug build). Put its `google-services.json` in `packages/web/android/app/`. Without it the
   Android build has no push, and the switch is not offered.
2. In the Apple developer account: the Push Notifications capability on `day.kolibri.client`, and an
   APNs authentication key (`.p8`). Xcode's automatic signing picks the capability up from the
   entitlement.
3. Run the relay — `docker compose -f docker-compose.relay.yml up -d` — with the service account
   and the key, behind TLS at `push.kolibri.day` (or set `KOLIBRI_PUSH_RELAY` on the servers to
   wherever it is).

**What is measured and what is not.** `relay.test.ts` checks everything that would leave the relay
against stand-ins for Google and Apple: both JWTs verify with the matching public keys, the request
shapes are the documented ones, and each documented answer is handled. `app-push.test.ts` checks
that what leaves a server carries no title, body, workspace or user id. Neither shows that Apple and
Google accept a real key, that a banner appears, or that a tap on a closed app lands on the inbox.
That needs the credentials and a phone.

## What is not done

- **SSO.** `ssoHref` is root-relative, and the provider redirects back to the *server's* origin —
  which the app is not. Making OIDC work in the shell means a registered deep link and a redirect
  target that reaches it; the app ID already claims a URL scheme, and nothing listens on it yet.
- **Store listings.** No screenshots, no privacy manifest, no `PrivacyInfo.xcprivacy`, no App Store
  or Play Console entry. `TARGETED_DEVICE_FAMILY` is `1,2`, so App Store Connect will want iPad
  screenshots as well as iPhone ones.
- **Anything measured on a device.** Every claim here about how a WebView behaves was reasoned from
  the platform's documentation and the client's own code. The client half is walked across a real
  origin boundary by `check:packaged` — the bundle answered as Capacitor answers it, the API on
  another origin, `window.Capacitor` present, at a phone's viewport — and that is not the same as a
  phone. Neither native project has been compiled: Xcode does not run where this repository is built,
  and the Android SDK was not installed there because doing so means accepting Google's licence on
  somebody's behalf. Specifically unmeasured:

  - Whether `NSAllowsLocalNetworking` reaches a numeric `http://192.168.x.x` address on iOS.
  - Whether a WebView applies Chromium's Local Network Access rules to the app. Desktop Chromium
    does: a page it considers public reaching a loopback or private address is refused unless the
    user allows it, and `check:packaged` has to switch that off to walk at all. Irrelevant for a
    server on a public address; possibly not for a development server on the same wifi.
  - How large the adaptive icon looks in a launcher. Its fill is derived conservatively, from the
    circle Android *guarantees* rather than the one a launcher usually shows, so it may read small
    beside other apps. One number in `brand.py`, with the trade-off written beside it.
  - Whether the launch screen hands over to the app without a flash. Splash, WebView ground and the
    web manifest are all `#0b0d12`, so a dark-mode start should be one colour throughout and a
    light-mode one should change once at the end — but nobody has watched it happen.

- **`npm audit`, as of this writing:** six moderate advisories, every one reached through
  `@capacitor/cli` — `uuid` through `xcode`, and `glob` and `minimatch` through `rimraf`. A
  build-time devDependency that writes the native projects; nothing in it ships, and the offered
  fix downgrades the CLI. Two low ones, `katex` through `mermaid`, are the web client's own and not
  the app's. The four plugins the app added (`filesystem`, `share`, `file-transfer`,
  `push-notifications`) bring none.