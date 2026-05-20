# Privacy Policy

This extension runs only on the YouTube Studio music pages declared in the manifest:

- `https://studio.youtube.com/*`
- `https://www.youtube.com/audiolibrary*`

It reads music page/API data in the active browser tab only to prepare download filenames and direct download URLs. Downloads are started through the browser download manager with the `chrome.downloads` API.

The extension does not send collected track data, filenames, URLs, browsing data, or download history to any external service.
