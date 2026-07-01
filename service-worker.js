/* MiViAm service worker — offline app shell + runtime audio cache.
 * Plain vanilla SW, no build step. See project_tracking/pwa_conversion_plan.md.
 */
var SHELL_CACHE = "miviam-shell-v155";
var AUDIO_CACHE = "miviam-audio-v7";   // v7: Celeste samples re-recorded in place (incl. the
                                       // E4 filename fix) - same URLs, new bytes. Cache-first, so only a purge (a
                                       // fresh cache name) delivers the new bytes to already-cached clients.
                                       // (v6 = flute re-record; v5 = flute URL rename; v4 = choir.)

// Small app shell — precached on install. Audio is intentionally NOT here
// (it is ~12 MB and runtime-cached on demand, one format per browser).
var SHELL = [
	"./",
	"index.html",
	"main.css?v=58",
	"js/main.js?v=122",
	"manifest.webmanifest",
	"img/bg.jpg",
	"img/content_bg.png",
	"img/title.png",
	"img/square_logo.jpg",
	"img/icon-192.png",
	"img/icon-512.png",
	"img/icon-maskable-512.png",
	"img/apple-touch-icon-180.png"
];

self.addEventListener("install", function (event) {
	event.waitUntil(
		caches.open(SHELL_CACHE)
			.then(function (cache) { return cache.addAll(SHELL); })
			.then(function () { return self.skipWaiting(); })
	);
});

self.addEventListener("activate", function (event) {
	event.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(keys.map(function (key) {
				if (key !== SHELL_CACHE && key !== AUDIO_CACHE) {
					return caches.delete(key);
				}
			}));
		}).then(function () { return self.clients.claim(); })
	);
});

self.addEventListener("fetch", function (event) {
	var req = event.request;
	if (req.method !== "GET") { return; }

	var url = new URL(req.url);
	if (url.origin !== self.location.origin) { return; }

	// Never let the SW serve its own script from cache (keeps updates working).
	if (url.pathname.indexOf("service-worker.js") !== -1) { return; }

	// Audio: runtime cache-first with HTTP Range support.
	if (url.pathname.indexOf("/snd/") !== -1) {
		event.respondWith(handleAudio(req));
		return;
	}

	// Navigations: network-first, fall back to the cached shell when offline.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req).catch(function () {
				return caches.match("index.html").then(function (r) {
					return r || caches.match("./");
				});
			})
		);
		return;
	}

	// Everything else (css/js/img/manifest): cache-first, then network.
	event.respondWith(
		caches.match(req).then(function (cached) {
			if (cached) { return cached; }
			return fetch(req).then(function (resp) {
				if (resp && resp.status === 200) {
					var clone = resp.clone();
					caches.open(SHELL_CACHE).then(function (c) { c.put(req, clone); });
				}
				return resp;
			});
		})
	);
});

// Cache-first for audio. Range requests are answered from a cached COMPLETE
// (200) copy — the Cache API cannot store a 206, so we only ever cache a 200
// and synthesize partial responses ourselves.
function handleAudio(req) {
	return caches.open(AUDIO_CACHE).then(function (cache) {
		var u = new URL(req.url);
		var keyUrl = u.origin + u.pathname; // path-only key, shared across range requests — query strings can never bloat the audio cache
		return cache.match(keyUrl).then(function (full) {
			if (full) {
				return req.headers.has("range") ? buildRange(req, full) : full;
			}
			// Fetch the whole file (no Range) so we can cache it and serve ranges.
			return fetch(keyUrl).then(function (resp) {
				if (!resp || resp.status !== 200) {
					return fetch(req); // couldn't get a full copy — defer to network
				}
				return cache.put(keyUrl, resp.clone()).then(function () {
					return req.headers.has("range") ? buildRange(req, resp) : resp;
				});
			}).catch(function () {
				return fetch(req); // offline and not cached — let it fail naturally
			});
		});
	});
}

function buildRange(req, fullResp) {
	return fullResp.clone().arrayBuffer().then(function (buf) {
		var total = buf.byteLength;
		var m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
		var start, end;
		if (m && m[1] === "" && m[2] !== "") {
			start = Math.max(0, total - parseInt(m[2], 10)); // suffix: last N bytes
			end = total - 1;
		} else {
			start = (m && m[1] !== "") ? parseInt(m[1], 10) : 0;
			end = (m && m[2] !== "") ? parseInt(m[2], 10) : total - 1;
		}
		if (isNaN(start) || start < 0) { start = 0; }
		if (isNaN(end) || end >= total) { end = total - 1; }
		if (start > end) { start = 0; end = total - 1; }

		var body = buf.slice(start, end + 1);
		return new Response(body, {
			status: 206,
			statusText: "Partial Content",
			headers: {
				"Content-Type": fullResp.headers.get("Content-Type") || "application/octet-stream",
				"Content-Range": "bytes " + start + "-" + end + "/" + total,
				"Content-Length": String(body.byteLength),
				"Accept-Ranges": "bytes"
			}
		});
	});
}
