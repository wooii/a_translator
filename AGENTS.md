# A Translator — Microsoft Edge extension (MV3)

Published on the Microsoft Edge Add-ons store only. Edge-first, Chrome-compatible but not the target.

## Entrypoints
- `background.js` — service worker: Google Translate fetch, message handler, context menu
- `content.js` — injected into every page (`<all_urls>`): selection icon, popup, TTS, **browser-AI provider** (Translator API), and the "⬇ Download on-device model" notice affordance (see MV3 quirks). A `mainworld.js` (`"world": "MAIN"`) content script existed 2026-08-16 for the download but was removed once Edge 151 proved the isolated world can download — restore from /tmp/opencode/mainworld.js (or git history) if that ever regresses.
- `options.html` / `options.js` — settings page (also the action popup via `default_popup`); inline `<style>` + external options.js
- `styles.css` — content-script CSS (icon/popup) per manifest
- `manifest.json` — MV3; permissions: `contextMenus`, `storage` (removed unused `activeTab`/`scripting` 2026-08)

## MV3 quirks
- Content scripts CAN `fetch()` `translate.googleapis.com` directly — the endpoint returns `access-control-allow-origin: *` (verified 2026-08). The code routes Google through the service worker anyway via `chrome.runtime.sendMessage({ action: 'translate', text })`; the listener returns `true` for async `sendResponse`.
- **Browser-AI (Translator API) cannot run in the service worker.** It runs directly in content.js. `create()` needs user activation ONLY while a language pair's model isn't downloaded — with the pair cached, `create()` works with zero activation (context-menu path is on-device for cached pairs).
- **There is no way to synthesize user activation**: `chrome.scripting.executeScript({userGesture:true})` does not exist in Chromium; W3C webextensions #898 is an open proposal. The 🔍 icon click is a REAL user click, so its transient activation (~5s window) lets the extension **auto-attempt the download** on that path (detector + availability round-trips fit inside the window): when the pair is `downloadable`/`downloading` AND `navigator.userActivation.isActive` → `autoDownload` (no extra click); on failure it falls back to Google with the affordance. Activation-free paths (context menu) go **straight to Google** showing the download affordance in the notice.
- **Windows Edge download behavior (2026-08-16, verified on the user's machines)**:
  - Edge 148: on-demand downloads are broken — `create()` never settles, no `downloadprogress`, `availability()` stays `downloadable` for a long while, yet the download may complete **silently in the background** (minutes later the pair flips to `available` on its own). `Translator.availability()` is the ONLY reliable completion signal there → the 3s poll in `downloadModel` is load-bearing. A second `create()` while a background download is running wedged the renderer on 148.
  - **Edge 151 fixes on-demand downloads on Windows** (works like Mac, ~1–2s). Mac Edge always worked.
  - The download service can wedge per browser session: a pair that failed repeatedly downloads instantly after an **Edge restart**, while a page reload does NOT fix it (hence the restart hint in the failure message).
  - Edge pre-downloads zh/ja/ko/ru models in the background on fresh profiles; everything else is `downloadable` until first use.
- **The download machinery is hidden from the user** — no progress bar, no failure counters, no suppressed states (`dlFails` removed 2026-08-16). The Google notice carries `data-source`/`data-target` and an inline "⬇ Download on-device model" affordance; clicking anywhere on the notice **re-attempts the download every time**. The affordance briefly shows "Downloading on-device models…"; a failed attempt shows the one-liner "Download didn't finish — using Google. Try again or restart the browser." (the same message for timeout, rejection, and sync throw — Windows `create()` hangs for unsupported pairs instead of rejecting, so the extension synthesizes the failure). Success re-translates on-device.
- **`downloadModel`** (shared by `autoDownload` and `startModelDownload`): runs `Translator.create()` synchronously in the real click task from the content-script isolated world, with a 3s `Translator.availability()` poll as the completion detector and **600ms auto / 3s manual timeout**. **No `monitor` option is passed** — on Edge 148 the `monitor` option is suspected of blocking the download from starting (every context that passed `monitor` hung; the one context verified working called `create()` without it).
- `host_permissions` (manifest.json) lists **only** `translate.googleapis.com`. The Translator API needs **no host permission** — it's a built-in web API.
- Background → content protocol: `translate_request` with `{ text }` (background.js:17-22) is the context-menu entry; the content script answers by translating (on-device or via `translate` → Google). Keep the two sides in sync.

## Translation flow — two entry points, same popup
1. Select text → 🔍 icon (`addSearchIcon`, content.js) → click → `translateSelection`: if `provider === 'browser'` and `Translator` available: translate in-page (Loading… popup → result), else `sendToBackground` → Google.
2. Right-click selection → "Translate" context menu (created in `onInstalled`, background.js:3-15) → `chrome.tabs.sendMessage(tab.id, { action: 'translate_request' })` → same `translateSelection`. On-device when the pair's model is cached (or Edge pre-downloaded it); otherwise falls back to Google — both automatically. If no content script is injected (e.g. `edge://`, PDF viewer, extension pages), the message is dropped: the menu item is a no-op (no Google fallback in background).

Both render `#translation-popup`: original text, 🔊 TTS for the original (voice matched to the detected source language via `detectSourceLang`/`pickVoiceFor`), translation, 🔊 TTS for the translation (voice matched to the target language via `BROWSER_LANG_MAP`), optional "More" link (Google only).

**Privacy notice**: whenever a result came from Google (`moreUrl` present), the popup shows an amber notice "⚠ Translated by Google." — its exact wording never changes. When the Translator API is available (`browserCapable`), the notice is **clickable**: for pairs whose model is already available it sets `provider` to `browser` and re-translates on-device; when the pair needs a download (`needsActivation`), the inline "⬇ Download on-device model" affordance is appended inside it and clicking anywhere on the notice re-attempts the download (see MV3 quirks). Download errors render as the one-liner under the notice. On-device results show no notice.

Closing the popup (click outside, selection collapse, or a new translation) calls `closePopup()`, which runs `speechSynthesis.cancel()` — audio always stops with the popup.

### Logic flow (as implemented, 2026-08)
1. **On-device attempt** — `translateSelection` (content.js): if `provider !== 'google'` and `Translator` exists → check `modelStatus` (async `Translator.availability({sourceLanguage, targetLanguage})`, falling back to `Translator.capabilities()`; states `available`/`downloadable`/`downloading`/`unavailable`). If the pair needs a download (`downloadable`/`downloading`): with user activation present (🔍 icon click) → **auto-attempt the download** via `autoDownload` (popup just shows "Downloading on-device models…"; success → re-translate on-device, failure → Google with the affordance); without activation (context menu) → **straight to Google** with the download affordance. Only `available` pairs run `runAttempt` → `withTimeout(attemptOnDevice(...), ON_DEVICE_TIMEOUT = 45000)`. Resolve → `showPopup(text, out, null, null)` (no moreUrl → no notice, no link). Reject or 45s timeout → step 2.
2. **Google fallback** — `sendToBackground` (content.js): `sendMessage({ action: 'translate', text })` with a 15s guard (`setTimeout`, `finish` guards double-fire); response `{ translation, moreUrl }` or `{ error }` → `showPopup`; timeout/lastError → error popup.
3. **Background Google** — `doTranslate` (background.js:35-39) reads only `targetLanguage` — background only ever does Google; provider choice lives in the content script. `translateGoogle` (background.js:55-65) via `fetchWithTimeout` (background.js:41-53, `FETCH_TIMEOUT = 12000`, AbortController): abort → "Connection timed out (server unreachable)"; TypeError → "Network error — check your internet connection."; all failures → `{ error }` response.
4. **Same-source short-circuit** — if detected source === target, the text is returned unchanged (popup shows text twice, no notice). `detectSourceLang` (content.js): `LanguageDetector` first, Unicode fallback `guessLang` (zh/ja/ko/ru/th/bn/ta, else en).

## Translation providers
- **Browser AI** (`provider: "browser"`, default) — Edge's **built-in Translator API** (`Translator.create`, Edge 148+): on-device, instant (~15ms/sentence), private, offline; the browser manages its own shared model, downloaded on demand the first time the API is used (per language pair, shared across all sites). Source detection via built-in `LanguageDetector`, fallback to Unicode ranges (`guessLang`). Needs **user activation** → only the 🔍 icon path auto-downloads; everything else falls back to Google.
- **Google Translate** (`translate.googleapis.com/translate_a/single`) — free, no key, auto-detects source, CORS-open. Returns `translation` + `moreUrl` (the popup's "More" link). Fallback: older browsers, unsupported pairs, failed downloads, provider set to `google`.
- **On-device output normalization**: `normalizePunct` (content.js) maps CJK punctuation to ASCII and fixes spacing in non-CJK output. Skipped when output contains CJK/kana/hangul.

## Options storage
- `chrome.storage.sync`: `targetLanguage` (default `en`), `provider` (default `browser`).
- Background reads `targetLanguage` on every translate (background.js:35-39); defaults are seeded in `onInstalled` when absent.
- `BROWSER_LANG_MAP` (content.js): Google codes → BCP-47 for Translator API (`zh-CN`→`zh`, `zh-TW`→`zh-Hant`, `iw`→`he`).

## Dev setup
- No build tools, no package.json, no dependencies — vanilla JS. Load unpacked from `edge://extensions`, developer mode. Edit → reload extension → test.
- All files flat in the repo root (plus `icons/` and `test/`). `test/` is the standalone download/quality harness — `node test/server.js` → http://localhost:8123 → tab "2. Quality + latency" → "Run quality + latency". It is THE tool for verifying whether a given Edge build can download models on demand (Mac Edge: almost instant; Windows Edge 148+: hangs; Edge 151+: works).

## Style
- ES5-era: `var`, function expressions, no arrows/const/let — no transpiler. (Some modern APIs already in use: `fetch`, `AbortController`, spread, `Object.assign`, `Translator`, `LanguageDetector`.)
- Content script is one IIFE; **all user text inserted into popup HTML must go through `esc()`** (XSS).

## Known risks
- Browser-AI needs Edge ≥148 (desktop). Edge 148's on-demand download path is broken on Windows — update to Edge 151+ where downloads work normally; older browsers/other engines fall back to Google silently.
- Context-menu path has no user activation → first use of a *fresh* language pair falls back to Google (with notice) until the pair's model is cached via the "⬇ Download on-device model" affordance (needs a click; the 🔍 path auto-attempts the download without one) or a prior use. Edge pre-downloads zh/ja/ko/ru models in the background, so those work immediately.
- Built-in AI is experimental; `Translator` availability and language pairs vary by build. All failures fall back to Google, so worst case = current behavior.
- Browser-AI does not provide a "More" link (no moreUrl). Targets `eo` (Esperanto), `tl` (Filipino), `sr` (Serbian) are unsupported by the Translator API in Edge (verified 2026-08) → always Google.
- The download service can wedge per browser session — a pair that keeps failing downloads instantly after an Edge restart (page reload does NOT fix it). Unsupported pairs never get a download affordance anyway: `availability()` reports `unavailable` → Google fallback without `needsActivation`.
- Context menu is a no-op on pages without the content script (`edge://`, PDF viewer, extension pages): background just forwards `translate_request` and swallows the send failure (background.js:17-22). No translation happens there.

## Research history (2026-08, condensed)
- **Verdict**: browser-first + visible Google fallback. Browser AI (Translator API) beats Google on speed (5–40× faster with cached models) with parity quality; the ~1GB local-AI alternatives (NLLB/Qwen via transformers.js, WebGPU-only) were benchmarked and dropped — 12× slower than the built-in API, not worth an extension-managed download.
- The download saga (why the current design is what it is): downloads fail from extension *pages* and from `monitor`-passing contexts on Edge 148; the page main world always worked; `mainworld.js` (`world: MAIN`) was the interim download path; Edge 151 fixed downloads from the isolated world, so the download moved into content.js and all progress UI was removed for simplicity.
