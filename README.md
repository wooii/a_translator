# A Translator

Translate selected text on any webpage — by default translated on-device with your browser's built-in AI, falling back to Google Translate when that's not possible.

**GitHub**: [wooii/a_translator](https://github.com/wooii/a_translator)

## How it works

- Select text, then click the 🔍 icon or right-click → **Translate**.
- The result appears in a popup: original text, translation, and 🔊 pronunciation for both.
- When Google did the translation, the popup shows a notice — click it to switch back to on-device AI.
- On-device models download automatically on first use; if a download fails, the notice offers a "⬇ Download on-device model" link to retry. If it keeps failing, the pair may not be supported by Browser AI — though a browser restart may get the download working.

## Translation providers

- **Browser AI** (default): on-device via the browser's built-in Translator API — instant, private, works offline (Edge 148+ / Chrome 138+).
- **Google Translate**: free online fallback. Used automatically when Browser AI can't translate (older browser, unsupported language, model not downloaded).

Configure the provider and target language (50 supported) in the extension options.

## Privacy

A Translator does not collect, store, or sell any personal data. The extension has no analytics, no tracking, and no accounts.

- **Data stored on your device**: your settings (translation provider and target language) are stored in the browser's own storage and may be synced by the browser.
- **Data sent to Google**: when Google Translate is used (either because you selected Google as the provider, or because the built-in on-device Browser AI is unavailable), the text you selected is sent to `translate.googleapis.com` for translation. On-device translations are processed entirely in your browser and never leave your device. The popup always displays a notice ("⚠ Translated by Google.") whenever a translation was performed by Google.
- **Text-to-speech** uses your browser's built-in speech synthesis and runs locally.
- **No remote code**: all code is bundled in the extension package; network requests go only to `translate.googleapis.com` and only when translating via Google.

## Installation

**Edge**: [Get it from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/a-translator/ocnfikpoagmgjappgpigidpimbljpipo)

**Development**: download this repository, then in Chrome (`chrome://extensions/`) or Edge (`edge://extensions/`) enable Developer mode and click **Load unpacked** — select the folder with these files.

## License

MIT
