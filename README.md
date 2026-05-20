# YouTube Studio Music Downloader

Manifest V3 Chrome/Edge extension for downloading free music tracks from YouTube Studio with clean metadata-based filenames.

## Install

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this project folder.
5. Open `https://studio.youtube.com/channel/<your-channel-id>/music`.
6. Reload the YouTube Studio page after installing or reloading the extension.

## Usage

The extension adds two visible buttons near the top-right of the YouTube Studio music page:

- `Download page` downloads only the tracks from the currently loaded page.
- `Download all tracks` sets `Rows per page` to `100`, walks every music page through the Studio API, prepares direct URLs, and sends all downloads to the browser.

Downloads are named with the available Studio metadata:

```text
Artist - Title (Year) (Genre) (Mood).mp3
```

Example:

```text
Jeremy Korpas, Rick Barry - Elysian Fields (2026) (Rock) (Dramatic).mp3
```

## Debug Button

The 8-page sample download button is still implemented but hidden by default. To show it again, set `SHOW_TEST_BUTTON` to `true` in `js/inject_script.js`, then reload the unpacked extension and refresh YouTube Studio.

## Notes

The extension uses YouTube Studio API responses from the current browser tab, requests direct download URLs in batches, and starts browser-managed downloads through the `chrome.downloads` API.
