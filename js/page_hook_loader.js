/**
 * Injects a main-world hook so the extension can capture YouTube Studio API
 * responses that contain music download URLs.
 */

(function () {
    'use strict';

    const EVENT_NAME = 'ytsm-downloads';
    const STORE_KEY = '__YTSM_DOWNLOADS__';

    globalThis[STORE_KEY] = globalThis[STORE_KEY] || new Map();

    window.addEventListener(EVENT_NAME, function (event) {
        const items = event.detail && Array.isArray(event.detail.items) ? event.detail.items : [];

        items.forEach(function (item) {
            if (!item || typeof item.url !== 'string') {
                return;
            }

            globalThis[STORE_KEY].set(item.url, item);
        });
    });

    injectHook(['js/page_hook.js']);

    function injectHook(paths) {
        if (document.documentElement && document.documentElement.dataset.ytsmHookInjected === 'true') {
            return;
        }

        if (!document.documentElement) {
            document.addEventListener('DOMContentLoaded', function () {
                injectHook(paths);
            }, { once: true });
            return;
        }

        document.documentElement.dataset.ytsmHookInjected = 'true';
        tryPath(paths, 0);
    }

    function tryPath(paths, index) {
        if (index >= paths.length) {
            return;
        }

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(paths[index]);
        script.async = false;
        script.onload = function () {
            script.remove();
        };
        script.onerror = function () {
            script.remove();
            tryPath(paths, index + 1);
        };

        (document.head || document.documentElement).appendChild(script);
    }
})();
