/**
 * Shared command names for content script <-> service worker messaging.
 * Kept on globalThis so Manifest V3 service workers can import it with importScripts().
 */
globalThis.Commands = Object.freeze({
    Download: 'download',
    Notify: 'notify'
});
