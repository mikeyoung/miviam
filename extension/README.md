# MiViAm browser extension (Chrome + Firefox)

A thin wrapper that ships the **MiViAm** web app as a browser extension. The
toolbar button opens the full app in its own dedicated tab; everything runs
**offline** because all 96 samples + the shell are packaged inside the extension.

This directory holds only the **source** (manifests, the background opener, the
build script). The loadable bundles are generated into `dist/` (gitignored).

## Why a tab, not a popup
An extension popup closes the moment it loses focus, which would tear down the
Web Audio graph and stop playback. So the toolbar `action` has **no popup** — its
`onClicked` handler opens `index.html` in a normal tab, where audio persists for
as long as the tab is open. (A docked side panel / sidebar is a possible later
upgrade; `chrome.offscreen` audio is Chrome-only and overkill here.)

## Layout
```
extension/
  build.ps1              # assembles dist/<browser>/ from the live web-app assets
  src/
    background.js        # the opener (identical for both; both expose chrome.*)
    manifest.chrome.json # Chrome MV3 (background.service_worker)
    manifest.firefox.json# Firefox MV3 (background.scripts + gecko id)
  dist/                  # generated, gitignored
    chrome/   firefox/
```

## Build
From the repo root (PowerShell 7+):
```
pwsh extension/build.ps1            # both browsers
pwsh extension/build.ps1 -Target chrome
pwsh extension/build.ps1 -Target firefox
```
Each bundle is a copy of `index.html`, `main.css`, `manifest.webmanifest`, `js/`,
`img/`, `snd/`, plus that browser's `manifest.json` and the shared `background.js`.
The PWA **service worker is intentionally not copied** — `js/main.js` skips
registering it on the `chrome-extension:` / `moz-extension:` origin (a no-op on
the live https site), and the assets are already packaged. **Re-run the build
after any web-app change** to refresh the bundle.

## Load unpacked (for testing)
- **Chrome / Edge / Brave:** `chrome://extensions` → enable *Developer mode* →
  *Load unpacked* → select `extension/dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
  → select any file inside `extension/dist/firefox` (e.g. `manifest.json`).
  Temporary add-ons are removed when Firefox restarts.

Click the toolbar icon → MiViAm opens in a new tab → press **Start**.

## Packaging for the stores
- **Chrome Web Store:** zip the **contents** of `dist/chrome` (manifest at the zip
  root) and upload in the Developer Dashboard.
- **Firefox (AMO):** zip the contents of `dist/firefox` as an `.xpi` and submit at
  addons.mozilla.org for signing (required to install permanently). The
  `browser_specific_settings.gecko.id` (`miviam@mikeyoung.org`) is the add-on id.

Store review + signing is the slow part; the bundle itself needs no code changes.

## Permissions
**None.** The button uses `action.onClicked` + `tabs.create()` with an in-extension
URL, neither of which requires a permission — which keeps store review simple.
The trade-off: clicking the button twice opens two tabs. Per-tab de-duplication
(focus the existing tab) is a future polish that would cost the `tabs` permission.

## Version
The extension `version` **mirrors the app's display version** — same `[major].[minor]`
format with the minor as a plain integer (2.9 → 2.10, NOT semver). When packaging a
release, set the manifest `version` in BOTH files to the app's current version (currently
**2.35**).
