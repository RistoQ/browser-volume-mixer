# Firefox Volume Mixer

A Firefox WebExtension that behaves like the Windows Volume Mixer: one **master volume**
slider plus a **per-tab** slider, percentage box and mute toggle for every tab that is
making sound or holds audio it could play. A tab can be turned up to **200 %**, and the
volume you give a site is remembered.

Firefox exposes no `tabCapture` / per-tab audio API to extensions, so this works the way
every Firefox volume add-on has to: it injects a script into the page, patches the page's
own media objects and inserts a Web Audio `GainNode` in front of the output. See
[How it works](#how-it-works) and [Limitations](#limitations).

**Install:** download the latest signed `volume-mixer.xpi` from
[Releases](https://github.com/RistoQ/browser-volume-mixer/releases/latest), then open it and
accept Firefox's prompt. See [Installing for real](#installing-for-real-signed-xpi).

---

## File structure

```
browser-volume-mixer/
├── manifest.json          MV2: browser_action + background page + content scripts
├── shared.js              constants shared by background, popup and the bridge
├── background.js          per-tab gains, per-site memory, media reports, badge, message hub
├── popup/
│   ├── popup.html         master controls + the per-tab list
│   ├── popup.css          styling (dark, 340 px)
│   └── popup.js           live UI: rows are reconciled in place, sends are throttled
├── content/
│   ├── media-hook.js      MAIN world: patches the page's audio objects, owns the GainNodes
│   └── bridge.js          isolated world: the only thing that talks to both sides
├── icons/                 icon-48/96/128.png
├── updates.json           the update manifest Firefox polls for new versions
├── web-ext-config.mjs     keeps the dev-only files out of linting/packaging
├── .github/workflows/
│   └── release.yml        on a version tag: lint, sign on AMO, publish the .xpi
├── test/
│   ├── test-audio.html    a page that plays a real <audio> element, for manual testing
│   └── probe.html         smoke-test probe page: reports which main-world hook patches landed
└── tools/                 dev-only (exclude when packaging)
    ├── make_icons.py      regenerates the icons
    ├── make_updates.py    records a released version in updates.json
    ├── sign.sh            signs the .xpi on AMO for self-distribution
    └── validate.py        structural sanity checks
```

## What the popup shows

Every control moves in **5 % steps**: the sliders declare `step="5"`, the `−5 %` / `+5 %`
buttons step by 5, and a typed percentage is snapped to the same grid (137 becomes 135).
The number inputs' native spinner arrows are hidden — the explicit `−5 %` / `+5 %` buttons
replace them.

- **Master volume** — `−5 %`, slider, `+5 %`, percentage box, 0–200 %. Applied as a
  multiplier on top of each tab's own level.
- **Toolbar badge** — the selected tab's own volume, visible without opening the popup:
  `30`, `200`, or `M` when the tab is muted, and nothing at 100 %. Boosted tabs (>100 %)
  get the accent colour, and the tooltip spells it out. The badge reflects the tab's own
  level, not the master.
- **Reset all tabs to 100 %** — every tab back to 100 %, master back to 100 %, and unmute
  all tabs.
- **One row per tab that can play audio** — not only the tabs making noise. The hook
  reports the playable `<audio>` / `<video>` elements it finds in every frame, so a paused
  YouTube or YouTube Music tab, or a page holding an embedded player, stays listed; so does
  a tab that is merely muted or turned down. Each row has the tab's **favicon**, its
  **title**, a **100 %** button that resets that one tab (volume only — it leaves mute
  alone), a **mute/unmute** button, and the same `−5 %` / slider / `+5 %` / percentage
  controls as the master. A row whose tab is not currently audible is dimmed.
- A warning note on rows that cannot be controlled or cannot be boosted (see
  [Limitations](#limitations)), and a footer counting the listed tabs and how many of them
  are actually playing.

Rows are added and removed live while the popup is open: the background page watches
`tabs.onUpdated` (`changeInfo.audible` / `mutedInfo`) and `tabs.onRemoved` and pushes a new
state snapshot to the popup over a long-lived port.

## How it works

```
 popup ──port──► background.js ──tabs.sendMessage──► content/bridge.js (isolated world)
                     │  ▲                                     │ window.postMessage
                     │  └──── storage.local ──┐               ▼
                     └───────────────────────┴── content/media-hook.js (MAIN world)
                                                              └─ HTMLMediaElement
                                                                  └─ GainNode → destination
```

1. **`content/media-hook.js` is a `world: "MAIN"` content script at `document_start`.**
   Running in the page's own realm is what makes it able to reach the page's audio objects.
   It patches `HTMLMediaElement.prototype.play`, the `volume` accessor,
   `Document.prototype.createElement`, the `Audio` constructor,
   `AudioContext.prototype.createMediaElementSource`, `AudioNode.prototype.connect` /
   `disconnect` and `HTMLMediaElement.prototype.setMediaKeys` — all before the page gets a
   chance to run. Elements are discovered three ways: the constructor/`createElement`
   patches, a `MutationObserver`, and a 2-second sweep that also looks into open shadow
   roots. A `WeakMap` makes `register()` idempotent.

2. **How a tab's level is applied.** For every registered element:

   | Requested | What happens |
   |---|---|
   | 0 – 100 % | `element.volume = pageVolume × gain` — native property, no routing, works everywhere |
   | > 100 % | the element is routed through a `GainNode`; the gain node carries the boost |

   For the boost path there are two cases: if the page already called
   `createMediaElementSource()` (many players do), the hook splices its own gain node
   between that source node and whatever the page connects it to. Otherwise the hook
   creates its own `AudioContext` for the document and routes the element into it. An
   element's own `volume` is left at the value the page chose, so the effective level is
   the page's level multiplied by the tab's gain. The context is checked first — a
   suspended `AudioContext` would swallow the audio — and while it is not running the
   element stays on the native path.

3. **What is *not* routed, and why.** Routing a media element through Web Audio is
   irreversible, and a cross-origin stream served without CORS becomes **silent** once
   routed. So the hook only routes when it can prove it is safe: same-origin URL, or a
   `blob:` / `data:` / `mediastream:` source, or an element that already opted into CORS
   via `crossOrigin`. Anything else keeps the native path (loudness and mute still work,
   boost does not) and is reported to the popup, which prints a note on that row. The same
   applies to DRM elements (`setMediaKeys()` has been called).

4. **`content/bridge.js` (isolated world)** is the only piece that can see both sides. It
   holds the tab gain (received from the background page) and the master gain (read from
   `storage.local`, updated through `storage.onChanged`), computes
   `effective = tabGain × master`, and forwards it to the hook with `window.postMessage`.
   In the other direction it forwards the hook's "how many elements are playing, how many
   are boost-limited" reports to the background page. Because the content script is
   registered for all frames, each frame runs its own bridge and gets its own copy of the
   tab's gain.

5. **`background.js`** keeps a volume per tab for the session, and on every change writes it
   to `storage.local` keyed by the tab's **origin**. That is what makes a volume outlive the
   popup, a reload, a navigation and even a browser restart: tab ids are not stable across
   restarts, origins are. It answers each content script's `vm:hello` with the gain that
   applies to the current URL, keeps the master gain in the same store (every frame picks it
   up through `storage.onChanged`), aggregates the per-frame reports into a per-tab media
   count so the popup can list audio-capable tabs, pings tabs so the popup can tell whether
   they are controllable, and pushes volume changes to **all frames** of a tab with a single
   `tabs.sendMessage`.

6. **Muting** uses Firefox's own tab muting (`tabs.update(tabId, {muted: true})`) rather
   than gain 0, so it works even for tabs whose audio the extension cannot touch.

## Installing for real (signed `.xpi`)

Firefox refuses to install an add-on from a folder on the Release and Beta channels:
only **Mozilla-signed** packages are accepted there. So the three ways in are:

| Route | Who it works for | What it costs |
|---|---|---|
| `about:debugging` (below) | you, now | the add-on is gone when Firefox closes |
| `xpinstall.signatures.required = false` | you, but only on Developer Edition, Nightly or ESR | that preference does not exist on Release/Beta |
| **a signed `.xpi`** (this section) | anyone you give the file to | an AMO account and one signing run per version |

Releases are therefore signed on AMO's **unlisted** channel: AMO signs the package but
publishes no listing, and the signed `.xpi` is distributed from this repository's releases.
That is exactly why **this repository is public**: Firefox fetches the `.xpi` and the update
manifest with no credentials, and GitHub serves release assets and raw files only from a
public repository — an anonymous request to a private one answers 404, so a private repo can
distribute to nobody but its owner.

### Installing a release

1. Download `volume-mixer.xpi` from
   [the newest release](https://github.com/RistoQ/browser-volume-mixer/releases/latest).
2. Open it — drag it onto a Firefox window, use **File → Open File**, or click it in the
   downloads panel. GitHub hands release assets over as downloads (`Content-Disposition:
   attachment`), so the link saves the file rather than installing straight from the page;
   opening the saved file is what asks Firefox to install it.
3. Accept Firefox's "Add Firefox Volume Mixer?" prompt.

No `about:debugging`, no `about:config`: from here the add-on behaves like any installed
extension — it survives restarts and updates itself (see below). Firefox **142 or newer** is
required, which the manifest enforces.

### Signing a release (maintainer)

One-time setup: a developer account on [addons.mozilla.org](https://addons.mozilla.org/developers/)
and an API key from <https://addons.mozilla.org/developers/addon/api/key/>. Keep the two
values in `~/.amo.env` (outside this repository, `.gitignore`d) as `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET`, or export them.

Then sign locally:

```
bash tools/sign.sh               # -> web-ext-artifacts/<id>-<version>-an+fx.xpi
python tools/make_updates.py --tag v1.0.0 --xpi web-ext-artifacts/<that .xpi>
```

...or push a tag and let CI do the whole thing — bump `version` in `manifest.json` first and
use that same number in the tag, because the release takes its version from the manifest and
not from the tag (tagging `v1.0.1` while the manifest still says `1.0.0` publishes a package
that disagrees with its own release):

```
git tag v1.0.1 && git push origin v1.0.1
```

`.github/workflows/release.yml` then runs the checks, signs the add-on (from the
`AMO_API_KEY` / `AMO_API_SECRET` repository secrets — set once with
`gh secret set AMO_API_KEY --repo RistoQ/browser-volume-mixer`, or under Settings → Secrets
and variables → Actions), attaches `volume-mixer.xpi` and `updates.json` to the release and
records the version in `updates.json` on the default branch. Unlisted submissions are
normally signed within seconds by the automated review; any submission can still be looked
at by a human afterwards, so read the
[add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
before shipping something you would not want reviewed.

Three things about those distribution URLs are easy to get wrong:

- **They must be publicly readable — the repository has to stay public.** That is the reason
  it is public: Firefox fetches the `.xpi` and `updates.json` anonymously, and GitHub answers
  404 to anonymous requests for raw files or release assets in a private repository. Making it
  private again (or deleting, renaming or transferring it) breaks the update check for
  everyone who already installed, for the next reason.
- **`update_url` is permanent.** An installed add-on keeps using the `update_url` baked
  into the version it installed; if that URL ever stops resolving, those copies can never
  be pointed at a new one — only an enterprise policy could redirect them. The URL, the
  branch it lives on and the account it lives under are all one-way doors for existing
  users, so treat them as fixed.
- **`update_url` and a public AMO listing are mutually exclusive.** An add-on that carries
  one is rejected for listing, so choosing self-distribution here closes that door.

### Automatic updates

`browser_specific_settings.gecko.update_url` points at the raw URL of `updates.json` on
the default branch, and Firefox polls it whenever it checks for add-on updates (JSON
update manifest — the old RDF form has been gone for years). `tools/make_updates.py`
appends the released version with an `https` `update_link` to that release's `.xpi` and
the `.xpi`'s sha256; `tools/validate.py` fails if the file's add-on id or its URLs drift
away from the manifest. Only the `update_url` in the manifest and this file matter —
`updates.json` is not part of the package.

## Development install & test locally (Firefox, `about:debugging`)

1. Open Firefox and go to **`about:debugging#/runtime/this-firefox`**.
2. Click **"Load Temporary Add-on…"**.
3. Select **`manifest.json`** in this folder.
4. "Firefox Volume Mixer" appears in the extensions list and its icon in the toolbar.
   A temporary add-on is dropped when Firefox closes — load it again the same way after a
   restart. It also needs Firefox **142 or newer** — the manifest uses
   `browser_specific_settings.gecko.data_collection_permissions`, which desktop Firefox
   understands from 140 and Firefox for Android from 142.
5. Iterating: editing a file needs **Reload** on the extension's card in `about:debugging`.
   Reloading only re-injects content scripts into pages loaded *after* the reload, so also
   reload the tab you are testing (except for `background.js`-only changes).

### Manual test checklist

Open `test/test-audio.html` (see below) or any media site, then:

| # | Step | Expected |
|---|---|---|
| 1 | Play audio in one tab, open the popup | That tab is listed with its favicon and title; master reads the value you last set |
| 2 | Click the row's `−5 %` / `+5 %` | Both the slider and the percentage box move 5 points per click, audio follows |
| 3 | Drag the row's slider | It only lands on multiples of 5 (100 → 105 → 110 …) |
| 4 | Type `137` in the row's percentage box, press Enter | Snaps to `135`; slider and audio follow |
| 5 | Drag a row slider to 200 % | Audio is clearly louder than the site's own maximum |
| 6 | Click the row's `100%` button | Only that tab returns to 100 %, mute state untouched |
| 7 | Click **Mute** | Audio stops, button flips to "Unmute", the tab also shows muted in Firefox's own tab strip; **Unmute** restores it |
| 8 | Play audio in a second tab, lower it | Only that tab changes; the first is untouched |
| 9 | Use the master `−5 %` / `+5 %` or slider | Every listed tab scales by the same factor, on top of its own level |
| 10 | Pause a tab that was playing | The row stays, dimmed — the tab still holds audio it could play |
| 11 | Close a tab with audio | Its row disappears |
| 12 | Set a tab to 150 % and reload that tab | Still 150 % once it plays again (gains are re-pushed on load) |
| 13 | Set YouTube to 50 %, then open a second YouTube tab | The new tab starts at 50 % — the volume is remembered for the site |
| 14 | Navigate a tab to a different site | It takes that site's remembered volume, not the previous site's |
| 15 | Restart Firefox, then reopen the site | Still at the volume you set; master is remembered too |
| 16 | Click **Reset all tabs to 100 %** | Everything back to 100 % *and* the remembered per-site volumes are forgotten |
| 17 | Open the popup on a protected page (`about:preferences`) | Row (if any) says "Not controllable" and every control is disabled |
| 18 | Watch the toolbar icon while a tab sits at 150 % | Badge reads `150` in the accent colour; at 100 % the badge is empty |
| 19 | Mute a tab and watch the icon | Badge reads `M`; unmuting brings the percentage (or nothing) back |
| 20 | Hover the toolbar button | Tooltip names the tab's volume, or "muted" |

### The local test page

`test/test-audio.html` builds a small WAV in memory, hands it to a real `<audio>` element
through a same-origin `blob:` URL and loops it — the case the extension fully supports,
including boost. It also prints the element's own `volume` so you can see that the
extension leaves the page's value alone and multiplies it. Open it with
**File → Open File**. (`file://` pages are scriptable only if the `file://` host permission
is granted to the extension; if you see "Not controllable", serve the folder over
`python -m http.server` and open `http://localhost:8000/test/test-audio.html` instead.)

Audio a page makes *outside* of `<audio>`/`<video>` — for example a bare `OscillatorNode`
wired straight to `AudioContext.destination` — is not a media element, so the mixer does
not control it. It will still make the tab audible and therefore listed.

## Limitations

- **Cross-origin media without CORS** cannot be routed (routing it would silence it
  permanently), so such elements fall back to native volume: 0–100 % and mute work, boost
  does not. The popup flags the row.
- **DRM / EME streams** are detected (`setMediaKeys`) and never routed, for the same
  reason. Native lowering and mute still work.
- **Boost tops out at 200 %** (`MAX_GAIN = 2` in `shared.js`, mirrored by the popup's input
  bounds).
- **Routing is one-way.** Once an element is routed it stays routed; if that element's
  source later changes to a cross-origin URL, the boost may go silent and cannot be undone.
- **Amplifying an already-loud signal clips.** That is physics, not a bug — use the tab
  slider to attenuate loud tabs and the master slider for overall balance.
- **Non-media audio** (raw Web Audio graphs, audio moved into a worker) is out of scope.
- **Protected pages** (`about:`, `file://` without permission, `view-source:`, some PDF
  viewers) cannot be scripted at all; the popup marks them "Not controllable". Child frames
  are only reached if their own URL is scriptable.
- **Volumes are remembered per site, not per tab.** Tab ids are not stable across a browser
  restart, so the durable key is the origin. A tab's own setting wins while that tab stays on
  the site, which means two tabs of the same site can hold different volumes in one session;
  the last change is what new or reloaded tabs of that site inherit. `file://` pages have no
  usable origin, so their volume is session-only, and **Reset all** deliberately forgets the
  remembered per-site volumes as well.
- **A tab appears only once the hook has seen media in it.** On a page whose player is built
  lazily that takes up to one sweep interval (2 s), and media inside a *closed* shadow root is
  only noticed when it actually plays.
- The audio hook attaches when an element is discovered; audio that was already playing when
  the extension was loaded needs the element to be re-registered (reload the tab, or
  pause/play).

## Development notes

```
python tools/validate.py                       # manifest, referenced files, icon sizes, JS bracket balance, updates.json
node --check shared.js background.js content/bridge.js content/media-hook.js popup/popup.js
npx web-ext lint --self-hosted                 # add-on manifest lint (0 errors, 0 warnings, 0 notices)
npx web-ext build                              # package as a .zip -> web-ext-artifacts/
bash tools/sign.sh                             # actually sign it for Firefox (needs AMO credentials)
```

`--self-hosted` is required now that the manifest carries an `update_url`: without it the
linter reports `MANIFEST_UPDATE_URL` as an error, because a Mozilla-hosted add-on may not
point updates elsewhere. AMO itself accepts the key for the unlisted channel. The release
workflow runs `tools/validate.py` and this lint before it signs, so a tag that would publish
something inconsistent fails before it reaches AMO.

`web-ext-config.mjs` keeps `tools/`, `test/`, `README.md`, `updates.json`, `.github/` and
the original prompt file out of linting and out of the packaged add-on, because those are
development-only (the `.py` files would otherwise trip web-ext's `FLAGGED_FILE_TYPE`
notice).