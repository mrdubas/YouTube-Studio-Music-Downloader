/**
 * Content script for YouTube Studio music pages.
 */

(function (Commands) {
    'use strict';

    const WIDGET_ID = 'ytsm-downloader-widget';
    const CURRENT_BUTTON_ID = 'ytsm-downloader-current-button';
    const BUTTON_ID = 'ytsm-downloader-button';
    const TEST_BUTTON_ID = 'ytsm-downloader-test-button';
    // Set to true while debugging to show the 8-page sample download button.
    const SHOW_TEST_BUTTON = false;
    const WIDGET_TOP_PX = 75;
    const WIDGET_RIGHT_PX = 225;
    const UI_VERSION = '0.1.12';
    const STATUS_ID = 'ytsm-downloader-status';
    const REPORT_ID = 'ytsm-downloader-report';
    const CAPTURED_DOWNLOADS_KEY = '__YTSM_DOWNLOADS__';
    const COLLECT_ALL_REQUEST_EVENT = 'ytsm-collect-music';
    const COLLECT_ALL_PROGRESS_EVENT = 'ytsm-music-collection-progress';
    const COLLECT_ALL_COMPLETE_EVENT = 'ytsm-music-collection-complete';
    const COLLECT_ALL_ERROR_EVENT = 'ytsm-music-collection-error';
    const ROUTE_CHECK_DELAY_MS = 250;
    const DIRECT_URL_WAIT_MS = 1800;
    const COLLECTION_TIMEOUT_MS = 15 * 60 * 1000;
    const TEST_PAGE_LIMIT = 8;
    const TEST_SAMPLE_PER_PAGE = 1;
    const ROWS_PER_PAGE_VALUE = '100';
    const ROWS_PER_PAGE_ATTEMPT_DELAY_MS = 800;
    const ROWS_PER_PAGE_RETRY_MS = 10000;
    const ROWS_PER_PAGE_OPTION_DELAY_MS = 250;
    const DOWNLOAD_WORDS = [
        'download',
        'scarica',
        'descargar',
        'telecharger',
        'herunterladen',
        'baixar',
        'downloaden',
        'pobierz',
        'stahnout',
        '\u0437\u0430\u0432\u0430\u043d\u0442\u0430\u0436\u0438\u0442\u0438',
        '\u0441\u043a\u0430\u0447\u0430\u0442\u044c'
    ];
    const DIRECT_DOWNLOAD_PATTERNS = [
        /\/audiolibrary_download/i,
        /audio[_-]?library/i,
        /download/i,
        /videoplayback/i,
        /mime=audio/i,
        /\.(mp3|wav|m4a|aac|ogg)(\?|#|$)/i
    ];
    const DOWNLOAD_CONTROL_SELECTOR = [
        'button',
        '[role="button"]',
        'a:not([href])',
        'ytcp-button',
        'ytcp-icon-button',
        'ytcp-icon-button-light',
        'yt-icon-button',
        'tp-yt-paper-icon-button',
        'paper-icon-button',
        '[aria-label]',
        '[title]'
    ].join(',');
    const ROW_SELECTOR = [
        'ytmus-library-row',
        'ytmus-library-table ytmus-library-row',
        'ytcp-audio-track-row',
        'ytcp-audio-library-track',
        'ytcp-audio-row',
        'ytcp-table-row',
        'ytcp-data-table-row',
        '[role="row"]',
        '.track-list > *',
        '.audio-library-track'
    ].join(',');

    let widget;
    let currentButton;
    let button;
    let testButton;
    let status;
    let report;
    let routeTimer;
    let rowsPerPageTimer;
    let lastRowsPerPageAttempt = 0;
    let observer;

    init();

    function init() {
        refreshWidget();

        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        window.addEventListener('popstate', scheduleRefresh);
        window.addEventListener('hashchange', scheduleRefresh);
    }

    function scheduleRefresh() {
        clearTimeout(routeTimer);
        routeTimer = setTimeout(refreshWidget, ROUTE_CHECK_DELAY_MS);
    }

    function refreshWidget() {
        if (!isMusicPage()) {
            removeWidget();
            return;
        }

        ensureWidget();
        scheduleRowsPerPageSetup();
    }

    function isMusicPage() {
        const host = window.location.hostname;
        const path = window.location.pathname.toLowerCase();

        if (host === 'www.youtube.com') {
            return path.indexOf('/audiolibrary') === 0;
        }

        if (host === 'studio.youtube.com') {
            return path.indexOf('/audio') !== -1 ||
                path.indexOf('/music') !== -1 ||
                path.indexOf('/copyright/audio') !== -1 ||
                normalizedText(document.title).indexOf('audio library') !== -1;
        }

        return false;
    }

    function isStudioMusicPage() {
        return window.location.hostname === 'studio.youtube.com';
    }

    function scheduleRowsPerPageSetup() {
        clearTimeout(rowsPerPageTimer);
        rowsPerPageTimer = setTimeout(function () {
            attemptSetRowsPerPage100(false);
        }, ROWS_PER_PAGE_ATTEMPT_DELAY_MS);
    }

    function attemptSetRowsPerPage100(force) {
        if (!isStudioMusicPage()) {
            return;
        }

        const now = Date.now();

        if (!force && now - lastRowsPerPageAttempt < ROWS_PER_PAGE_RETRY_MS) {
            return;
        }

        lastRowsPerPageAttempt = now;

        if (bodyShowsRowsPerPage100()) {
            return;
        }

        const control = findRowsPerPageControl();

        if (!control) {
            return;
        }

        clickRowsPerPageControl(control);
        setTimeout(clickRowsPerPage100Option, ROWS_PER_PAGE_OPTION_DELAY_MS);
    }

    function clickRowsPerPageControl(control) {
        const clickTarget = control.querySelector('ytcp-dropdown-trigger, [role="button"], button') || control;

        if (typeof clickTarget.scrollIntoView === 'function') {
            clickTarget.scrollIntoView({
                block: 'center',
                inline: 'nearest'
            });
        }

        dispatchHover(clickTarget);
        clickTarget.click();
    }

    function bodyShowsRowsPerPage100() {
        const text = normalizedText(document.body ? document.body.innerText : '');

        return text.indexOf(`rows per page ${ROWS_PER_PAGE_VALUE}`) !== -1 ||
            text.indexOf(`rows per page: ${ROWS_PER_PAGE_VALUE}`) !== -1 ||
            text.indexOf(`rows per page ${ROWS_PER_PAGE_VALUE} `) !== -1;
    }

    function findRowsPerPageControl() {
        const controls = Array.from(document.querySelectorAll([
            'ytcp-select',
            'ytcp-text-menu',
            'ytcp-dropdown-trigger',
            'tp-yt-paper-dropdown-menu',
            '[role="combobox"]',
            'button',
            '[role="button"]',
            '[aria-label]'
        ].join(',')));

        return controls.find(function (control) {
            if (!isVisible(control) || isExtensionElement(control)) {
                return false;
            }

            const label = normalizedText([
                getElementLabel(control),
                control.textContent,
                getClosestText(control, 'ytcp-table-footer, ytcp-pagination, .ytcp-table-footer, .pagination')
            ].join(' '));

            return label.indexOf('rows per page') !== -1 &&
                (cleanText(control.textContent) !== ROWS_PER_PAGE_VALUE || label.indexOf(`rows per page ${ROWS_PER_PAGE_VALUE}`) === -1);
        });
    }

    function clickRowsPerPage100Option() {
        const option = Array.from(document.querySelectorAll([
            '[role="option"]',
            'tp-yt-paper-item',
            'paper-item',
            'ytcp-ve',
            'ytcp-menu-service-item-renderer',
            'ytcp-text-menu-item'
        ].join(','))).find(function (candidate) {
            return isVisible(candidate) &&
                !isExtensionElement(candidate) &&
                cleanText(candidate.textContent) === ROWS_PER_PAGE_VALUE;
        });

        if (!option) {
            return;
        }

        dispatchHover(option);
        option.click();
    }

    function getClosestText(element, selector) {
        const closest = element.closest(selector);
        return closest ? closest.textContent : '';
    }

    function ensureWidget() {
        if (document.getElementById(WIDGET_ID)) {
            return;
        }

        widget = document.createElement('aside');
        widget.id = WIDGET_ID;
        widget.dataset.ytsmUiVersion = UI_VERSION;
        widget.style.top = `${WIDGET_TOP_PX}px`;
        widget.style.right = `${WIDGET_RIGHT_PX}px`;
        widget.setAttribute('aria-live', 'polite');

        currentButton = document.createElement('button');
        currentButton.id = CURRENT_BUTTON_ID;
        currentButton.type = 'button';
        currentButton.textContent = getMessage('lblDownloadCurrentPage', 'Download page');
        currentButton.title = getMessage(
            'lblDownloadCurrentPageNote',
            'Downloads only the tracks currently loaded in the visible YouTube Studio music page.'
        );
        currentButton.addEventListener('click', onClickDownloadCurrentPage);

        button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.textContent = getMessage('lblDownloadAllTracks', 'Download all tracks');
        button.title = getMessage(
            'lblDownloadAllTracksNote',
            'Collects every YouTube Studio music page, prepares direct URLs, then sends downloads to the browser.'
        );
        button.addEventListener('click', onClickDownloadTracks);

        testButton = document.createElement('button');
        testButton.id = TEST_BUTTON_ID;
        testButton.type = 'button';
        testButton.textContent = 'Test 8 pages';
        testButton.title = 'Downloads 1 sample track from each of the first 8 API pages.';
        testButton.hidden = !SHOW_TEST_BUTTON;
        testButton.addEventListener('click', onClickDownloadTest);

        status = document.createElement('span');
        status.id = STATUS_ID;
        status.textContent = '';

        report = document.createElement('pre');
        report.id = REPORT_ID;
        report.hidden = true;

        widget.appendChild(currentButton);
        widget.appendChild(button);
        widget.appendChild(testButton);
        widget.appendChild(status);
        widget.appendChild(report);
        document.documentElement.appendChild(widget);
    }

    function removeWidget() {
        const existingWidget = document.getElementById(WIDGET_ID);

        if (existingWidget) {
            existingWidget.remove();
        }

        widget = null;
        currentButton = null;
        button = null;
        testButton = null;
        status = null;
        report = null;
    }

    async function onClickDownloadTracks(event) {
        event.preventDefault();

        if (!button) {
            return false;
        }

        setBusy(true);
        clearReport();

        try {
            attemptSetRowsPerPage100(true);

            const audioTracks = isStudioMusicPage()
                ? await requestAllMusicDownloads()
                : await collectVisibleMusicDownloads();

            await downloadAudioTracks(audioTracks);
        } catch (error) {
            console.error(error);
            const message = isStudioMusicPage()
                ? getMessage('msgCollectionFailed', 'Could not collect YouTube Studio music pages. Reload the extension, refresh YouTube Studio, then try again.')
                : getMessage('msgDownloadRequestFailed', 'Unable to start downloads.');

            await notify(message);
            setStatus(message);
        } finally {
            setBusy(false);
        }

        return false;
    }

    async function onClickDownloadCurrentPage(event) {
        event.preventDefault();

        if (!currentButton) {
            return false;
        }

        setBusy(true);
        clearReport();

        try {
            const audioTracks = isStudioMusicPage()
                ? await requestAllMusicDownloads({ currentPageOnly: true })
                : await collectVisibleMusicDownloads();

            await downloadAudioTracks(audioTracks);
        } catch (error) {
            console.error(error);
            const message = getMessage(
                'msgCollectionFailed',
                'Could not collect the current YouTube Studio music page. Reload the extension, refresh YouTube Studio, then try again.'
            );

            await notify(message);
            setStatus(message);
        } finally {
            setBusy(false);
        }

        return false;
    }

    async function onClickDownloadTest(event) {
        event.preventDefault();

        if (!testButton) {
            return false;
        }

        setBusy(true);
        clearReport();

        try {
            attemptSetRowsPerPage100(true);

            const audioTracks = await requestAllMusicDownloads({
                pageLimit: TEST_PAGE_LIMIT,
                samplePerPage: TEST_SAMPLE_PER_PAGE,
                debug: true
            });

            showReport(audioTracks);
            await downloadAudioTracks(audioTracks);
        } catch (error) {
            console.error(error);
            const message = getMessage(
                'msgCollectionFailed',
                'Could not collect YouTube Studio music pages. Reload the extension, refresh YouTube Studio, then try again.'
            );

            await notify(message);
            setStatus(message);
        } finally {
            setBusy(false);
        }

        return false;
    }

    async function collectVisibleMusicDownloads() {
        setStatus(getMessage('msgScanningPage', 'Scanning page...'));

        let audioTracks = collectDirectDownloadItems();

        if (audioTracks.length === 0) {
            setStatus(getMessage('msgWaitingForDirectUrls', 'Waiting for direct download URLs...'));
            await delay(DIRECT_URL_WAIT_MS);
            audioTracks = collectDirectDownloadItems();
        }

        return audioTracks;
    }

    async function downloadAudioTracks(audioTracks) {
        const preparedTracks = enrichDownloadItemsWithLoadedRowMetadata(uniqueDownloadItems(audioTracks));

        if (preparedTracks.length === 0) {
            const message = getMessage(
                'msgDirectUrlsNotReady',
                'Direct download URLs are not ready yet. Reload the extension, refresh YouTube Studio, then try again.'
            );

            await notify(message);
            setStatus(message);
            return;
        }

        const result = await sendMessage({
            command: Commands.Download,
            data: preparedTracks
        });

        if (!result || result.ok === false) {
            setStatus(getMessage('msgDownloadRequestFailed', 'The browser could not start some downloads.'));
            return;
        }

        setStatus(getMessage(
            'msgQueuedDownloads',
            [result.started || preparedTracks.length],
            `${result.started || preparedTracks.length} download(s) sent to the browser.`
        ));
    }

    function requestAllMusicDownloads(options) {
        return new Promise(function (resolve, reject) {
            const requestId = `ytsm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            let settled = false;
            const timeoutId = setTimeout(function () {
                fail(new Error(getMessage('msgCollectionTimedOut', 'Timed out while collecting YouTube Studio music pages.')));
            }, COLLECTION_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timeoutId);
                window.removeEventListener(COLLECT_ALL_PROGRESS_EVENT, onProgress);
                window.removeEventListener(COLLECT_ALL_COMPLETE_EVENT, onComplete);
                window.removeEventListener(COLLECT_ALL_ERROR_EVENT, onError);
            }

            function done(items) {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                resolve(items);
            }

            function fail(error) {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                reject(error);
            }

            function onProgress(event) {
                const detail = event.detail || {};

                if (detail.requestId !== requestId) {
                    return;
                }

                setCollectionProgressStatus(detail);
            }

            function onComplete(event) {
                const detail = event.detail || {};

                if (detail.requestId !== requestId) {
                    return;
                }

                done(Array.isArray(detail.items) ? detail.items : []);
            }

            function onError(event) {
                const detail = event.detail || {};

                if (detail.requestId !== requestId) {
                    return;
                }

                fail(new Error(detail.message || getMessage(
                    'msgCollectionFailed',
                    'Could not collect YouTube Studio music pages. Reload the extension, refresh YouTube Studio, then try again.'
                )));
            }

            const requestOptions = options || {};

            window.addEventListener(COLLECT_ALL_PROGRESS_EVENT, onProgress);
            window.addEventListener(COLLECT_ALL_COMPLETE_EVENT, onComplete);
            window.addEventListener(COLLECT_ALL_ERROR_EVENT, onError);

            setStatus(requestOptions.currentPageOnly
                ? getMessage('msgCollectingCurrentPage', [0], 'Collecting current page: 0 tracks...')
                : getMessage('msgCollectingAllPages', 'Collecting all YouTube Studio music pages...'));
            window.dispatchEvent(new CustomEvent(COLLECT_ALL_REQUEST_EVENT, {
                detail: {
                    requestId,
                    options: requestOptions
                }
            }));
        });
    }

    function setCollectionProgressStatus(detail) {
        if (detail.stage === 'collecting-current') {
            const total = detail.total || detail.collected || 0;

            setStatus(getMessage(
                'msgCollectingCurrentPage',
                [total],
                `Collecting current page: ${total} tracks...`
            ));
            return;
        }

        if (detail.stage === 'preparing') {
            const prepared = detail.prepared || 0;
            const total = detail.total || detail.collected || 0;

            setStatus(getMessage(
                'msgPreparingDownloads',
                [prepared, total],
                `Preparing downloads: ${prepared} / ${total} tracks...`
            ));
            return;
        }

        const page = detail.page || 1;
        const collected = detail.collected || 0;
        const total = detail.total || collected;

        setStatus(getMessage(
            'msgCollectingPages',
            [page, collected, total],
            `Collecting page ${page}: ${collected} / ${total} tracks...`
        ));
    }

    function collectDirectDownloadItems() {
        return enrichDownloadItemsWithLoadedRowMetadata(
            uniqueDownloadItems(collectCapturedDownloadItems().concat(collectDownloadLinks()))
        );
    }

    function collectCapturedDownloadItems() {
        const captured = globalThis[CAPTURED_DOWNLOADS_KEY];

        if (!captured || typeof captured.values !== 'function') {
            return [];
        }

        return Array.from(captured.values())
            .filter(function (item) {
                return item && typeof item.url === 'string';
            })
            .map(function (item) {
                return {
                    trackId: item.trackId,
                    url: item.url,
                    filename: item.filename,
                    title: item.title,
                    artist: item.artist,
                    year: item.year,
                    genre: item.genre,
                    mood: item.mood
                };
            });
    }

    function collectDownloadLinks() {
        const items = [];
        const seen = new Set();
        const links = Array.from(document.querySelectorAll('a[href]'));

        links.forEach(function (link) {
            if (isExtensionElement(link)) {
                return;
            }

            const url = normalizeUrl(link.href);

            if (!url || seen.has(url)) {
                return;
            }

            if (!isLikelyDownloadLink(link, url)) {
                return;
            }

            seen.add(url);
            items.push({ url });
        });

        return items;
    }

    function uniqueDownloadItems(items) {
        const seen = new Set();

        return items.filter(function (item) {
            if (!item || typeof item.url !== 'string' || seen.has(item.url)) {
                return false;
            }

            seen.add(item.url);
            return true;
        });
    }

    function enrichDownloadItemsWithLoadedRowMetadata(items) {
        const rowMetadata = collectLoadedRowMetadata();

        if (!rowMetadata.size) {
            return items;
        }

        return items.map(function (item) {
            const title = item.title || getTitleFromFilename(item.filename);
            const metadata = rowMetadata.get(normalizedText(title));

            if (!metadata) {
                return item;
            }

            const merged = {
                url: item.url,
                title: item.title || metadata.title,
                artist: item.artist || metadata.artist,
                year: item.year || metadata.year,
                genre: item.genre || metadata.genre,
                mood: item.mood || metadata.mood,
                filename: item.filename
            };

            merged.filename = buildDownloadFilename(merged, item.url);
            return merged;
        });
    }

    function collectLoadedRowMetadata() {
        const metadata = new Map();

        Array.from(document.querySelectorAll('ytmus-library-row')).forEach(function (row) {
            const title = getRowCellText(row, '#title');
            const artist = getRowCellText(row, '#artist');
            const year = extractYear(getRowCellText(row, '#date'));
            const genre = getRowCellText(row, '#genre');
            const mood = getRowCellText(row, '#mood');

            if (!title) {
                return;
            }

            metadata.set(normalizedText(title), {
                title,
                artist,
                year,
                genre,
                mood
            });
        });

        return metadata;
    }

    function getRowCellText(row, selector) {
        const element = row.querySelector(selector);
        return element ? cleanText(element.textContent) : '';
    }

    function buildDownloadFilename(item, url) {
        const title = cleanText(item.title || getTitleFromFilename(item.filename));
        const artist = cleanText(item.artist);
        const year = extractYear(item.year);
        const genre = cleanText(item.genre);
        const mood = cleanText(item.mood);
        const extension = getDownloadExtension(item.filename, url);
        const parts = [artist, title].filter(Boolean);

        if (!parts.length) {
            return item.filename || '';
        }

        return sanitizeFilename(parts.join(' - ') + (year ? ` (${year})` : '') + (genre ? ` (${genre})` : '') + (mood ? ` (${mood})` : '') + `.${extension}`);
    }

    function getTitleFromFilename(filename) {
        return cleanText(String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, ''));
    }

    function getDownloadExtension(filename, url) {
        const filenameMatch = String(filename || '').match(/\.([a-z0-9]{2,5})$/i);

        if (filenameMatch) {
            return filenameMatch[1].toLowerCase();
        }

        const urlMatch = String(url || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);

        if (urlMatch) {
            return urlMatch[1].toLowerCase();
        }

        const mimeMatch = String(url || '').match(/[?&]mime=audio%2F([^&]+)/i) || String(url || '').match(/[?&]mime=audio\/([^&]+)/i);

        if (mimeMatch) {
            const subtype = decodeURIComponent(mimeMatch[1]).toLowerCase();

            if (subtype.indexOf('mp4') !== -1) {
                return 'm4a';
            }

            if (subtype.indexOf('webm') !== -1) {
                return 'webm';
            }
        }

        return 'mp3';
    }

    function sanitizeFilename(filename) {
        return filename
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    function cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractYear(value) {
        const match = String(value || '').match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : '';
    }

    function isLikelyDownloadLink(link, url) {
        const combinedText = [
            url,
            link.getAttribute('download'),
            getElementLabel(link)
        ].join(' ');

        if (DIRECT_DOWNLOAD_PATTERNS.some(function (pattern) {
            return pattern.test(combinedText);
        })) {
            return true;
        }

        return Boolean(link.getAttribute('download')) || textLooksLikeDownload(combinedText);
    }

    async function revealDownloadControls() {
        const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));

        for (const row of rows.slice(0, 300)) {
            dispatchHover(row);
            await delay(10);
        }

        dispatchHover(document.body);
        await delay(100);
    }

    function collectNativeDownloadButtons() {
        const controls = new Set();

        Array.from(document.querySelectorAll(ROW_SELECTOR)).forEach(function (row) {
            dispatchHover(row);
            Array.from(row.querySelectorAll('ytcp-button#download, ytcp-button[label], button[aria-label], ' + DOWNLOAD_CONTROL_SELECTOR)).forEach(function (control) {
                if (isNativeDownloadControl(control)) {
                    controls.add(control);
                }
            });
        });

        Array.from(document.querySelectorAll(DOWNLOAD_CONTROL_SELECTOR)).forEach(function (control) {
            if (isNativeDownloadControl(control)) {
                controls.add(control);
            }
        });

        return Array.from(controls);
    }

    function isNativeDownloadControl(control) {
        if (isExtensionElement(control) || isDisabled(control)) {
            return false;
        }

        if (control.tagName === 'A' && control.getAttribute('href')) {
            return false;
        }

        return textLooksLikeDownload(getElementLabel(control));
    }

    function clickNativeDownloadButtons(controls) {
        let clicked = 0;
        const seenLabels = new Set();

        for (const control of controls) {
            if (!document.documentElement.contains(control) || isDisabled(control)) {
                continue;
            }

            const label = getControlIdentity(control);

            if (label && seenLabels.has(label)) {
                continue;
            }

            if (label) {
                seenLabels.add(label);
            }

            dispatchHover(control);
            control.click();
            clicked += 1;
        }

        return clicked;
    }

    function getControlIdentity(control) {
        const row = control.closest(ROW_SELECTOR);
        const rowText = row ? normalizedText(row.textContent).slice(0, 200) : '';
        const label = normalizedText(getElementLabel(control));

        return `${label}|${rowText}`;
    }

    function normalizeUrl(href) {
        try {
            const url = new URL(href, document.baseURI);

            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return null;
            }

            url.hash = '';
            return url.href;
        } catch (error) {
            return null;
        }
    }

    function getElementLabel(element) {
        return [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-tooltip-text'),
            element.getAttribute('tooltip'),
            element.getAttribute('label'),
            element.textContent
        ].filter(Boolean).join(' ');
    }

    function textLooksLikeDownload(text) {
        const value = normalizedText(text);

        return DOWNLOAD_WORDS.some(function (word) {
            return value.indexOf(word) !== -1;
        });
    }

    function normalizedText(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isDisabled(element) {
        return element.disabled ||
            element.getAttribute('aria-disabled') === 'true' ||
            element.hasAttribute('disabled');
    }

    function isVisible(element) {
        if (!element || !document.documentElement.contains(element)) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        return rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
    }

    function isExtensionElement(element) {
        return Boolean(element.closest(`#${WIDGET_ID}`));
    }

    function dispatchHover(element) {
        ['pointerover', 'mouseover', 'mouseenter'].forEach(function (eventName) {
            element.dispatchEvent(new MouseEvent(eventName, {
                bubbles: true,
                cancelable: true,
                view: window
            }));
        });
    }

    function setBusy(isBusy) {
        if (!button) {
            return;
        }

        if (currentButton) {
            currentButton.disabled = isBusy;
            currentButton.classList.toggle('is-busy', isBusy);
        }

        button.disabled = isBusy;
        button.classList.toggle('is-busy', isBusy);

        if (testButton) {
            testButton.disabled = isBusy;
            testButton.classList.toggle('is-busy', isBusy);
        }
    }

    function setStatus(message) {
        if (status) {
            status.textContent = message || '';
        }
    }

    function clearReport() {
        if (!report) {
            return;
        }

        report.hidden = true;
        report.textContent = '';
    }

    function showReport(items) {
        if (!report) {
            return;
        }

        const lines = uniqueDownloadItems(items).map(function (item, index) {
            const filename = `${index + 1}. ${item.filename || buildDownloadFilename(item, item.url) || item.url}`;

            if (!item.debug) {
                return filename;
            }

            return [
                filename,
                `   list: ${formatMetadataForReport(item.debug.listTrack)}`,
                `   download: ${formatMetadataForReport(item.debug.downloadTrack)}`
            ].join('\n');
        });

        report.hidden = false;
        report.textContent = ['Test sample filenames:', ...lines].join('\n');
    }

    function formatMetadataForReport(debugTrack) {
        if (!debugTrack) {
            return 'no debug data';
        }

        return [
            `id=${debugTrack.trackId || ''}`,
            `artist=${debugTrack.artist || ''}`,
            `title=${debugTrack.title || ''}`,
            `year=${debugTrack.year || ''}`,
            `genre=${debugTrack.genre || ''}`,
            `mood=${debugTrack.mood || ''}`,
            `keys=${Array.isArray(debugTrack.keys) ? debugTrack.keys.slice(0, 12).join(',') : ''}`,
            `fields=${formatInterestingFields(debugTrack.interestingFields)}`
        ].join(' | ');
    }

    function formatInterestingFields(fields) {
        if (!fields || typeof fields !== 'object') {
            return '';
        }

        return Object.keys(fields).slice(0, 8).map(function (key) {
            return `${key}:${fields[key]}`;
        }).join('; ');
    }

    async function notify(message) {
        return sendMessage({
            command: Commands.Notify,
            message
        });
    }

    function sendMessage(message) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(message, function (response) {
                const lastError = chrome.runtime.lastError;

                if (lastError) {
                    console.warn(lastError.message);
                    resolve({
                        ok: false,
                        error: lastError.message
                    });
                    return;
                }

                resolve(response || { ok: true });
            });
        });
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

    function delay(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }
})(globalThis.Commands);
