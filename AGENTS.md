# A Translator — Microsoft Edge extension (MV3)

Edge-first translation extension (published on the Microsoft Edge Add-ons store only; Chrome-compatible but not the target). Translates selected text with the browser's built-in **Translator API** (on-device, default) and falls back to **Google Translate** when that's not possible. Vanilla JS, no build tools, no dependencies.

## Files
- `content.js` — the whole user experience: 🔍 selection icon, popup, TTS, on-device provider, model-download affordance. One ES5-style IIFE; most changes land here.
- `background.js` — service worker: context menu, message handler, Google Translate fetch. The Translator API can't run in a service worker, so the background **only ever does Google**; provider choice lives in content.js.
- `charsets.js` — **generated data, never hand-edit.** `HANS_CHARS`/`HANT_CHARS` (simplified↔traditional char sets) from OpenCC's `STCharacters.txt`. Must load **before** `content.js` in the manifest `js` array.
- `options.html`/`options.js` — provider radio + target language select; doubles as the toolbar popup (`default_popup`).
- `styles.css` — content-script CSS for icon/popup.
- `manifest.json` — MV3; permissions `contextMenus` + `storage`; `host_permissions` only `translate.googleapis.com` (the Translator API needs none — it's a built-in web API); content scripts `charsets.js`, `content.js` on `<all_urls>`.
- `README.md` — user-facing marketing/privacy doc; this file is the technical reference.

## Translation flow
Two entry points, one pipeline (`translateSelection`, content.js):
1. **🔍 icon** on selection (`addSearchIcon`) — a real user click, so it carries user activation (matters for downloads, below).
2. **Context menu** "Translate" — background forwards `translate_request` (background.js:17-22); same code path, no activation. No-op on pages without the content script (`edge://`, PDF viewer, extension pages) — the menu item is dropped silently.

`translateSelection` pipeline:
1. **Short-circuit** — `effectiveSource`/`hanScript` decide whether the text is already in the target language; if so, show it unchanged (no request, no notice). Chinese is decided by the text's **own script** via charsets.js (the detector's verdict is ignored — its `zh-CN`/`zh-TW` codes don't align with targets `zh`/`zh-Hant`); a single Han char overrides even a non-Chinese detector verdict; other languages compare base subtags (`en-US` → `en`).
2. **On-device** — only when `provider === 'browser'` and `Translator` exists. `modelStatus` (`availability()`, falling back to `capabilities()`) returns `available`/`downloadable`/`downloading`/`unavailable`. `available` → translate with a 45s timeout. `downloadable`/`downloading` → auto-attempt the download when user activation is present, else skip to Google with the download affordance.
3. **Google fallback** — `sendToBackground` (15s guard, content.js) → `{ action: 'translate' }` → `doTranslate` (background.js:35-39, reads `targetLanguage` per request) → `translateGoogle` (background.js:55-65) with a 12s abortable fetch (background.js:41-53). Popup shows the amber "⚠ Translated online." notice + "More" link.
4. **Popup** — original text, 🔊 TTS for both sides (voice matched via `detectSourceLang`/`pickVoiceFor`), translation, optional notice. Clicking the notice switches `provider` to `browser` and re-translates on-device; for pairs needing a download it re-attempts the download instead. On-device results show no notice. Closing the popup cancels speech.

On-device output goes through `normalizePunct` (CJK punctuation → ASCII; skipped when output contains CJK/kana/hangul). All user text inserted into popup HTML goes through `esc()` (XSS).

## Model download quirk (read before touching download code)
The Translator API only allows model downloads from a real user-activation task in the content-script isolated world — there is no way to synthesize activation (`userGesture:true` doesn't exist in Chromium), and `create()` without it rejects. With a **cached** pair, `create()` needs zero activation (context-menu path is on-device for cached pairs).

- **🔍 path** (activation present): a `downloadable`/`downloading` pair triggers `autoDownload` automatically — popup shows "Downloading on-device models…"; success re-translates on-device, failure falls back to Google.
- **Context-menu path** (no activation): straight to Google, download affordance shown in the notice.
- `downloadModel` (content.js): synchronous `Translator.create()` in the click task, **no `monitor` option** (suspected of blocking downloads on Edge 148), 3s `availability()` poll as the completion detector (the only reliable signal on Edge 148 — downloads can finish silently in the background), 600ms auto / 3s manual timeout. `modelDownloading` guards re-entry; failure is synthesized for pairs where Windows `create()` hangs instead of rejecting.
- UI is deliberately minimal: no progress bar, no counters. The notice carries `data-source`/`data-target`; clicking it re-attempts every time; failure shows the one-liner "Download didn't finish — using Google. Try again or restart the browser."
- Platform quirks (verified 2026-08): Windows Edge 148 on-demand downloads are broken (hang, silent background completion, a second concurrent `create()` can wedge the renderer); **Edge 151+ works (~1–2s)**; Mac always worked. The download service can wedge per browser session — restart fixes it, page reload doesn't. Edge pre-downloads zh/ja/ko/ru models on fresh profiles; everything else is `downloadable` until first use. Unsupported pairs (`eo`, `tl`, `sr` on Edge) report `unavailable` → plain Google fallback, no affordance.

## Storage
`chrome.storage.sync`: `targetLanguage` (default `en`), `provider` (default `browser`), seeded in `onInstalled`. `BROWSER_LANG_MAP` (content.js) maps Google codes → BCP-47 (`zh-CN`→`zh`, `zh-TW`→`zh-Hant`, `iw`→`he`).

## Conventions
- ES5-era style: `var`, function expressions, no arrows/const/let, no transpiler — though modern APIs are in use (`fetch`, `AbortController`, spread, `Object.assign`, `Translator`, `LanguageDetector`).
- Keep the background ↔ content protocol in sync: `translate` (content→background, Google) and `translate_request` (background→content, context menu).
- charsets.js is machine-generated from OpenCC — regenerate, never hand-edit.

## Dev workflow
No build: load unpacked from `edge://extensions` (developer mode), edit → reload → test. Files are flat in the repo root (+ `icons/`). When behavior changes, keep both README.md (user-facing) and this file updated.

## History (why it looks like this)
Browser-first was the benchmarked verdict: the built-in Translator API is 5–40× faster than Google with cached models at parity quality; the ~1GB local-AI alternatives (NLLB/Qwen via transformers.js) were 12× slower and dropped. The download machinery went through several forms: downloads failed from extension pages and from `monitor`-passing contexts on Edge 148; an interim `mainworld.js` (`world: MAIN`) content script worked; Edge 151 fixed isolated-world downloads, so the download moved into content.js and all progress UI was removed for simplicity.
