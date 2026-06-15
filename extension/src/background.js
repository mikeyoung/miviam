/* MiViAm browser-extension background opener (Chrome MV3 service worker +
   Firefox MV3 event page; identical code, both expose the chrome.* namespace).

   The toolbar button has NO popup on purpose: an extension popup closes on blur,
   which would tear down the Web Audio graph and stop playback. Instead the button
   opens the full app in its own dedicated tab, where audio persists as long as the
   tab is open — the v1 design from the bootstrap plan.

   tabs.create() with an in-extension URL needs no permissions, so the manifest
   ships with an empty permission set (best for store review). Clicking the button
   again simply opens another tab; per-tab de-duplication is a later polish that
   would cost the "tabs" permission. */
chrome.action.onClicked.addListener(function () {
	chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
