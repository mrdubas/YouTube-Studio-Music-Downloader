/**
 * Manifest V3 service worker for starting browser-managed downloads.
 */

importScripts('commons.js');

(function (Commands) {
    'use strict';

    const EXTENSION_TITLE = 'YouTube Studio Music Downloader';
    const DOWNLOAD_BATCH_SIZE = 100;
    const DOWNLOAD_BATCH_DELAY_MS = 1000;
    let activeDownloadBatch = Promise.resolve();

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || !msg.command) {
            return false;
        }

        if (msg.command === Commands.Download) {
            const downloads = uniqueDownloads(Array.isArray(msg.data) ? msg.data : []);

            activeDownloadBatch = activeDownloadBatch
                .catch(function () {
                    return undefined;
                })
                .then(function () {
                    return downloadUrls(downloads);
                });

            activeDownloadBatch
                .then(function (result) {
                    sendResponse(result);
                })
                .catch(function (error) {
                    console.error(error);
                    sendResponse({
                        ok: false,
                        error: error.message || String(error)
                    });
                });

            return true;
        }

        if (msg.command === Commands.Notify) {
            showNotification(msg.message || '')
                .then(function () {
                    sendResponse({ ok: true });
                })
                .catch(function (error) {
                    console.warn(error);
                    sendResponse({
                        ok: false,
                        error: error.message || String(error)
                    });
                });

            return true;
        }

        return false;
    });

    async function downloadUrls(downloads) {
        if (!downloads.length) {
            await showNotification(getMessage('msgAudioTracksNotFound', 'No audio tracks found.'));
            return { ok: false, started: 0, failed: 0 };
        }

        await showNotification(getFoundMessage(downloads.length));

        const results = [];

        for (let index = 0; index < downloads.length; index += DOWNLOAD_BATCH_SIZE) {
            const batch = downloads.slice(index, index + DOWNLOAD_BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async function (download) {
                const options = {
                    url: download.url,
                    saveAs: false,
                    conflictAction: 'uniquify'
                };

                if (download.filename) {
                    options.filename = download.filename;
                }

                try {
                    await chromeDownload(options);
                    return true;
                } catch (error) {
                    console.warn('Download failed:', download.url, error);
                    return false;
                }
            }));

            results.push.apply(results, batchResults);

            if (index + DOWNLOAD_BATCH_SIZE < downloads.length) {
                await delay(DOWNLOAD_BATCH_DELAY_MS);
            }
        }

        const started = results.filter(Boolean).length;
        const failed = results.length - started;

        if (failed > 0) {
            await showNotification(getMessage(
                'msgDownloadFinishedWithErrors',
                [started, failed],
                `${started} download(s) started, ${failed} failed.`
            ));
        }

        return {
            ok: failed === 0,
            started,
            failed
        };
    }

    function chromeDownload(options) {
        return new Promise(function (resolve, reject) {
            chrome.downloads.download(options, function (downloadId) {
                const lastError = chrome.runtime.lastError;

                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }

                if (!downloadId) {
                    reject(new Error('The browser did not start the download.'));
                    return;
                }

                resolve(downloadId);
            });
        });
    }

    function showNotification(message) {
        if (!message) {
            return Promise.resolve();
        }

        return new Promise(function (resolve, reject) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: chrome.runtime.getURL(getAssetPath('img/logo.png')),
                title: EXTENSION_TITLE,
                message
            }, function () {
                const lastError = chrome.runtime.lastError;

                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }

                resolve();
            });
        });
    }

    function delay(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    function getFoundMessage(count) {
        if (count === 1) {
            return getMessage('msgAudioTrackFound', '1 audio track found. Download will start soon.');
        }

        return getMessage(
            'msgAudioTracksFound',
            [count],
            `${count} audio track(s) found. Download will start soon.`
        );
    }

    function getMessage(name, substitutionsOrFallback, fallback) {
        let substitutions;
        let fallbackText;

        if (Array.isArray(substitutionsOrFallback)) {
            substitutions = substitutionsOrFallback;
            fallbackText = fallback || '';
        } else {
            substitutions = undefined;
            fallbackText = substitutionsOrFallback || '';
        }

        const message = chrome.i18n.getMessage(name, substitutions);
        return message || fallbackText;
    }

    function uniqueDownloads(downloads) {
        const seen = new Set();

        return downloads
            .map(normalizeDownload)
            .filter(function (download) {
                return download && /^https?:\/\//i.test(download.url);
            })
            .filter(function (download) {
                if (seen.has(download.url)) {
                    return false;
                }

                seen.add(download.url);
                return true;
            });
    }

    function normalizeDownload(download) {
        if (typeof download === 'string') {
            return { url: download };
        }

        if (!download || typeof download.url !== 'string') {
            return null;
        }

        return {
            url: download.url,
            filename: typeof download.filename === 'string' && download.filename ? download.filename : undefined
        };
    }

    function getAssetPath(path) {
        return path;
    }
})(globalThis.Commands);
