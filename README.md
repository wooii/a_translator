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

- **Browser AI (default)**: your selected text never leaves your device. Translation happens locally via the browser's built-in Translator API; the browser may download a translation model once per language pair.
- **Google Translate (fallback)**: your selected text is sent to Google's servers and processed by Google Translate. This happens automatically when Browser AI can't translate, or when you select Google as the provider in the options.
- The popup always shows a notice ("⚠ Translated by Google.") whenever a result came from Google, so you always know when your text went online.
- Text-to-speech uses your browser's built-in speech synthesis and runs locally.
- No analytics, no tracking, no remote code. The extension makes network requests only to `translate.googleapis.com` and only when translating via Google.

## Installation

**Edge**: [Get it from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/a-translator/ocnfikpoagmgjappgpigidpimbljpipo)

**Development**: download this repository, then in Chrome (`chrome://extensions/`) or Edge (`edge://extensions/`) enable Developer mode and click **Load unpacked** — select the folder with these files.

## License

MIT
