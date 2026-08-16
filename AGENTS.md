# A Translator — chrome extension

## Entrypoints
- `background.js` — service worker: Google Translate fetch, message handler, context menu
- `content.js` — injected into every page (`<all_urls>`): selection icon, popup, TTS, **browser-AI provider** (Translator API)
- `options.html` / `options.js` — settings page (also the action popup via `default_popup`); inline `<style>` + external options.js
- `styles.css` — content-script CSS (icon/popup) per manifest
- `manifest.json` — MV3; permissions: `contextMenus`, `storage` (removed unused `activeTab`/`scripting` 2026-08)

## MV3 quirks
- Content scripts CAN `fetch()` `translate.googleapis.com` directly — the endpoint returns `access-control-allow-origin: *` (verified 2026-08).
- However, the code routes Google through the service worker via `chrome.runtime.sendMessage({ action: 'translate', text })`, listener returns `true` for async `sendResponse`. Content script → background (`translate`) = Google path; background → content (`translate_request`) = ask the page to translate (on-device first).
- **Browser-AI (Translator API) cannot run in the service worker** — not available in workers and needs user activation for model downloads (Chrome docs). It runs directly in content.js. User activation is ONLY required while a language pair's model is not yet downloaded — with the pair cached, `create()` works without any activation (verified empirically 2026-08), so the context-menu path CAN be on-device.
- **There is no way to synthesize user activation**: `chrome.scripting.executeScript({userGesture:true})` does not exist in Chromium (verified against `extensions/common/api/scripting.idl`); W3C webextensions #898 is an open proposal. So first-use of an uncached pair on the context-menu path must fall back to Google.
- `host_permissions` (manifest.json) lists **only** `translate.googleapis.com`. The Translator API needs **no host permission** — it's a built-in web API.
- Background → content protocol: `translate_request` with `{ text }` (background.js:17-22; handled at content.js:227-233) is the context-menu entry; the content script answers by translating (on-device or via `translate` → Google). Keep the two sides in sync.

## Translation flow — two entry points, same popup
1. Select text → 🔍 icon (`addSearchIcon`, content.js) → click → `translateSelection`: if `provider === 'browser'` and `Translator` available: translate in-page (Loading… popup → result), else `sendToBackground` → Google.
2. Right-click selection → "Translate" context menu (created in `onInstalled`, background.js:3-15) → `chrome.tabs.sendMessage(tab.id, { action: 'translate_request' })` → same `translateSelection` in the content script. On-device when the pair's model is cached (or Edge pre-downloaded it); otherwise falls back to Google — both automatically. If no content script is injected (e.g. `chrome://`, PDF viewer, extension pages — content scripts never run there), the message is dropped: the menu item is a no-op (no Google fallback in background).
Both render `#translation-popup`: original text, 🔊 TTS for the original (voice matched to the detected source language via `detectSourceLang`/`pickVoiceFor`), translation, 🔊 TTS for the translation (voice matched to the target language via `BROWSER_LANG_MAP`), optional "More" link (Google only).
**Privacy notice**: whenever a result came from Google (`moreUrl` present), the popup shows an amber notice "Translated online by Google — your text left this device." On-device results show no notice. When the Translator API is available (`browserCapable`), the notice is **clickable**: it sets `provider` to `browser` in sync storage and re-translates the same text on-device (content.js:256-267); the popup keeps its position during the re-translation.
Closing the popup (click outside, selection collapse, or a new translation) calls `closePopup()`, which runs `speechSynthesis.cancel()` — audio always stops with the popup.

### Logic flow (as implemented, 2026-08)
1. **On-device attempt** — `translateSelection` (content.js:180-194): if `provider !== 'google'` and `Translator` exists → `withTimeout(translateWithBrowser(...), ON_DEVICE_TIMEOUT = 45000)` (content.js:165,188). Resolve → `showPopup(text, out, null, null)` (no moreUrl → no notice, no link). Reject or 45s timeout → step 2.
2. **Google fallback** — `sendToBackground` (content.js:196-219): `sendMessage({ action: 'translate', text })` with a 15s guard (`setTimeout` content.js:211, `finish` guards double-fire); response `{ translation, moreUrl }` or `{ error }` → `showPopup`; timeout/lastError → error popup.
3. **Background Google** — `doTranslate` (background.js:35-39) reads only `targetLanguage` — background only ever does Google; provider choice lives in the content script. `translateGoogle` (background.js:55-65) via `fetchWithTimeout` (background.js:41-53, `FETCH_TIMEOUT = 12000`, AbortController): abort → "Connection timed out (server unreachable)"; TypeError → "Network error — check your internet connection."; all failures → `{ error }` response.
4. **Same-source short-circuit** — `translateWithBrowser` (content.js:59-69): if detected source === target, returns the text unchanged (popup shows text twice, no notice). `detectSourceLang` (content.js:32-48): `LanguageDetector` first, Unicode fallback `guessLang` (content.js:21-30: zh/ja/ko/ru/th/bn/ta, else en).

## Translation providers
- **Google Translate** (`translate.googleapis.com/translate_a/single`) — free, no key, auto-detects source, CORS-open. Returns `translation` + `moreUrl` (the popup's "More" link). No published quota; per-IP throttling under heavy use. Works everywhere; fallback.
- **Browser AI** (`provider: "browser"`) — Edge/Chrome **built-in Translator API** (`Translator.create`, Edge 148+/Chrome 138+): on-device, instant (~15ms/sentence), private, offline; **no per-extension model download** — the browser manages its own shared model, downloaded on demand the first time the API is used (per language pair, shared across all sites). Source detection via built-in `LanguageDetector`, fallback to Unicode ranges (`guessLang`, content.js). Needs **user activation** → only the 🔍 icon path uses it; falls back to Google on any failure or unavailability.
- `provider` setting: `"browser"` (default) or `"google"`. (MyMemory and local transformers.js providers removed 2026-08 — see research history.)
- Google fetches go through `fetchWithTimeout` (`FETCH_TIMEOUT = 12000`, AbortController, background.js:1,41-53); timeout surfaces as "Connection timed out (server unreachable)". All failures → `{ error }` response.
- **On-device output normalization**: `normalizePunct` (content.js:71-77) maps CJK punctuation to ASCII and fixes spacing in non-CJK output. Skipped when output contains CJK/kana/hangul.

## Options storage
- `chrome.storage.sync`: `targetLanguage` (default `en`), `provider` (default `browser`).
- Background reads `targetLanguage` on every translate (background.js:35-39); defaults are seeded in `onInstalled` when absent.
- `BROWSER_LANG_MAP` (content.js): Google codes → BCP-47 for Translator API (`zh-CN`→`zh`, `zh-TW`→`zh-Hant`, `iw`→`he`).

## Dev setup
- No build tools, no package.json, no dependencies — vanilla JS. Load unpacked from `chrome://extensions` (Chrome) / `edge://extensions` (Edge), developer mode. Edit → reload extension → test.
- All files flat in the repo root (plus `icons/`). (The old `test/` browser-test tooling — translator-vs-google harness, probe-extension — was deleted 2026-08; its findings are preserved in Research history.)

## Style
- ES5-era: `var`, function expressions, no arrows/const/let — no transpiler. (Some modern APIs already in use: `fetch`, `AbortController`, spread, `Object.assign`, `Translator`, `LanguageDetector`.)
- Content script is one IIFE; **all user text inserted into popup HTML must go through `esc()`** (XSS).

## Research history — can the built-in Translator API replace Google? (2026-08, result: browser-first + visible Google fallback)
Benchmarked on the user's Edge (148+) with a throwaway `test/translator-vs-google/` harness (deleted 2026-08 with `test/probe-extension` — the extension's context-menu path is now itself the no-activation test). Verdict: not a hard 100% replacement — Google stays as an **always-visible fallback** (amber notice in the popup when text goes online).

- **Coverage (Edge, fresh + after cache)**: 45/48 target languages usable; only `eo` (Esperanto), `tl` (Filipino), `sr` (Serbian) are `unavailable` (also absent from Chrome's 39-language list). `LanguageDetector` available. (Dropdown later grew to 50 in 2026-08 with `bn`, `ur`, `ms`, `ta` — all usable in Edge; `bn`/`ta` also in Chrome's 39, `ur`/`ms` fall back to Google there.)
- **Quality: parity with Google** — 82–100% word overlap on a 7-language corpus; fr output identical to Google. One cosmetic flaw: on-device output keeps CJK punctuation in Latin text.
- **Latency (models cached)**: 25–167ms/sentence on-device vs Google 316–1424ms (5–40× faster). First-time per-pair model download: ~20–25s, needs a user click.
- **Activation**: `create()` requires activation ONLY when the pair's model isn't downloaded. Cached pairs: fresh `create()` works with zero activation (context-menu path). No way to synthesize activation (`userGesture` absent from `chrome.scripting`; W3C webextensions #898 open).
- **Fresh profile**: Edge pre-downloads zh/ja/ko/ru translation models in the background; everything else is `downloadable` until first use.
- **Transient activation expires after ~5s** — a model download needs a fresh user click per language pair (extension flow is one click → one translation, unaffected).

## Research history — local AI provider (2026-08, decided: NOT shipped)
Goal was "Google + one local provider". Benchmarked real candidates in a throwaway `test.html` (Edge, user's machine; the file was deleted after the decision — reproduce via the numbers below if ever re-evaluated):

- **NLLB-200-distilled-600M** (`Xenova/nllb-200-distilled-600M`, q8): ~2.2s/sentence avg on WebGPU, quality OK. q4f16+WebGPU produced **empty output** on this machine. ~1.25GB download. CC-BY-NC-4.0.
- **Qwen3.5-0.8B** (`onnx-community/Qwen3.5-0.8B-Text-ONNX`, q4f16): **~230ms/sentence avg, good quality** — the best local model. ~950MB download. Apache-2.0. Needs chat template (v4 returns `generated_text` as a messages array; `enable_thinking: false` goes in `tokenizer_encode_kwargs`).
- **WASM backend is dead for both**: q4f16 graphs fail (`InsertedPrecisionFreeCast` fused ops), q8 fails (`Missing required scale` qdq_actions) — onnxruntime-web 1.24.3 can't load these quantized graphs. Local AI effectively requires WebGPU.
- **Edge built-in Translator API (the winner)**: ~16-18ms/sentence avg (12x faster than Qwen), better quality, browser-managed model (one-time ~9.6s load, no extension download), Edge 148+/Chrome 138+. Requires user activation.
- **Verdict**: transformers.js offscreen-document plan dropped. "Local AI" = the built-in Translator API (`provider: "browser"`). The ~1GB per-extension model download is not worth 12x worse latency.
- Windows AI APIs (Phi Silica etc.) are native WinRT-only — not reachable from a browser extension, and they have no translation model anyway. macOS Core ML same wall.

## Known risks
- Browser-AI needs Edge ≥148 / Chrome ≥138 (desktop only — Chrome's API doesn't work on mobile); older browsers/other engines fall back to Google silently. First use of a language pair triggers a model download (browser-managed).
- Context-menu path has no user activation → first use of a *fresh* language pair falls back to Google (with notice) until the pair's model is cached via the 🔍 path or a prior use. Edge pre-downloads zh/ja/ko/ru models in the background (fresh-profile verified 2026-08), so those work immediately.
- Chrome/Edge built-in AI is experimental; `Translator` availability and language pairs vary by browser/build. All failures fall back to Google, so worst case = current behavior.
- Browser-AI does not provide a "More" link (no moreUrl). Targets `eo`/`tl`/`sr` are unsupported by the Translator API in Edge AND Chrome (verified Edge 2026-08) → always Google.
- Context menu is a no-op on pages without the content script (`chrome://`, PDF viewer, extension pages): background just forwards `translate_request` and swallows the send failure (background.js:17-22). No translation happens there.
