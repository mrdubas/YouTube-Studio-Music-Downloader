# YouTube Studio Music Downloader

<img width="1919" height="909" alt="Screenshot 2026-05-20 223331" src="https://github.com/user-attachments/assets/7801254c-ff5c-426a-8b45-a2592c1f7118" />


Manifest V3 Chrome/Edge extension for downloading free music tracks from YouTube Studio with clean metadata-based filenames.

## Install

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this project folder (If everything is working properly, it should look like the screenshot)
<img width="409" height="218" alt="Screenshot 2026-05-20 223630" src="https://github.com/user-attachments/assets/3eb933e4-1c54-462c-9cbf-ce03925a7f53" />


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

## Acknowledgements

This extension was inspired by the archived project
[youtube-audio-library-downloader](https://github.com/Ragnarokkr/youtube-audio-library-downloader)
by Ragnarokkr.

While this project was developed independently, that extension helped shape the idea and approach.
