/**
 * Main-world network hook. It observes YouTube Studio API responses and extracts
 * music download URLs before the isolated extension world needs them.
 */

(function () {
    'use strict';

    const EVENT_NAME = 'ytsm-downloads';
    const COLLECT_ALL_REQUEST_EVENT = 'ytsm-collect-music';
    const COLLECT_ALL_PROGRESS_EVENT = 'ytsm-music-collection-progress';
    const COLLECT_ALL_COMPLETE_EVENT = 'ytsm-music-collection-complete';
    const COLLECT_ALL_ERROR_EVENT = 'ytsm-music-collection-error';
    const MAX_TEXT_LENGTH = 15 * 1024 * 1024;
    const DOWNLOAD_URL_PATTERN = /https?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/audiolibrary_download\?[^"'\\\s<>,)]+/ig;
    const DOWNLOAD_HOST = 'https://www.youtube.com/audiolibrary_download?vid=';
    const PAGE_SIZE = 100;
    const DOWNLOAD_LOOKUP_BATCH_SIZE = 50;
    const DOWNLOAD_LOOKUP_RETRY_BATCH_SIZE = 10;
    const FORBIDDEN_REQUEST_HEADERS = new Set([
        'accept-charset',
        'accept-encoding',
        'access-control-request-headers',
        'access-control-request-method',
        'connection',
        'content-length',
        'cookie',
        'cookie2',
        'date',
        'dnt',
        'expect',
        'host',
        'keep-alive',
        'origin',
        'referer',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'user-agent',
        'via'
    ]);
    const hydratedTrackIds = new Set();
    let latestListTracksRequest = null;
    let collectionInProgress = false;

    if (window.__ytsmHookInstalled) {
        return;
    }

    window.__ytsmHookInstalled = true;
    hookFetch();
    hookXhr();
    window.addEventListener(COLLECT_ALL_REQUEST_EVENT, onCollectAllRequest);

    function hookFetch() {
        if (typeof window.fetch !== 'function') {
            return;
        }

        const originalFetch = window.fetch;

        window.fetch = function () {
            const fetchArgs = arguments;
            const requestMeta = getFetchRequestMeta(fetchArgs[0], fetchArgs[1]);

            return originalFetch.apply(this, fetchArgs).then(function (response) {
                inspectFetchResponse(requestMeta.url || response.url, response, requestMeta);
                return response;
            });
        };
    }

    function hookXhr() {
        if (!window.XMLHttpRequest || !window.XMLHttpRequest.prototype) {
            return;
        }

        const originalOpen = window.XMLHttpRequest.prototype.open;
        const originalSend = window.XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;

        window.XMLHttpRequest.prototype.open = function (method, url) {
            this.__ytsmRequestUrl = getRequestUrl(url);
            this.__ytsmRequestHeaders = {};
            return originalOpen.apply(this, arguments);
        };

        window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            this.__ytsmRequestHeaders = this.__ytsmRequestHeaders || {};
            this.__ytsmRequestHeaders[name] = value;
            return originalSetRequestHeader.apply(this, arguments);
        };

        window.XMLHttpRequest.prototype.send = function () {
            this.__ytsmRequestBody = arguments[0];
            this.addEventListener('load', inspectXhrResponse);
            return originalSend.apply(this, arguments);
        };
    }

    function inspectFetchResponse(url, response, requestMeta) {
        if (!response || typeof response.clone !== 'function') {
            return;
        }

        const contentType = response.headers && typeof response.headers.get === 'function'
            ? response.headers.get('content-type') || ''
            : '';

        if (!isLikelyRelevantUrl(url) && contentType.indexOf('json') === -1) {
            return;
        }

        response.clone().text()
            .then(function (text) {
                inspectResponseText(url, text, requestMeta);
            })
            .catch(function () {
                return undefined;
            });
    }

    function inspectXhrResponse() {
        if (this.responseType && this.responseType !== 'text') {
            return;
        }

        if (!isLikelyRelevantUrl(this.__ytsmRequestUrl) && !isLikelyRelevantText(this.responseText)) {
            return;
        }

        inspectResponseText(this.__ytsmRequestUrl, this.responseText, {
            bodyText: bodyToText(this.__ytsmRequestBody),
            headers: this.__ytsmRequestHeaders || {}
        });
    }

    function inspectResponseText(url, text, requestMeta) {
        if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
            return;
        }

        if (!isLikelyRelevantUrl(url) && !isLikelyRelevantText(text)) {
            return;
        }

        const items = [];
        const seen = new Set();

        extractDownloadUrls(text).forEach(function (downloadUrl) {
            addItem(items, seen, { url: downloadUrl });
        });

        const json = parseJson(text);

        if (json) {
            rememberListTracksRequest(url, requestMeta, json);
            collectFromJson(json, items, seen, new Set(), []);
            hydrateCreatorMusicDownloadUrls(url, requestMeta, json);
        }

        if (items.length) {
            window.dispatchEvent(new CustomEvent(EVENT_NAME, {
                detail: { items }
            }));
        }
    }

    function collectFromJson(value, items, seen, visited, ancestors) {
        if (!value || typeof value !== 'object' || visited.has(value)) {
            return;
        }

        visited.add(value);

        if (Array.isArray(value)) {
            value.forEach(function (entry) {
                collectFromJson(entry, items, seen, visited, ancestors);
            });
            return;
        }

        const nextAncestors = ancestors.concat(value);

        const downloadUrl = getFirstString(value, [
            'download_url',
            'downloadUrl',
            'downloadUri',
            'downloadAudioUrl',
            'download_audio_url',
            'audioDownloadUrl',
            'download_url_v2',
            'url'
        ]);

        if (downloadUrl && isDownloadUrl(downloadUrl)) {
            const metadata = getTrackMetadata(value, ancestors);

            addItem(items, seen, {
                url: cleanUrl(downloadUrl),
                title: metadata.title,
                artist: metadata.artist,
                year: metadata.year,
                genre: metadata.genre,
                mood: metadata.mood,
                filename: buildFilename(metadata, downloadUrl)
            });
        }

        const vid = getFirstString(value, [
            'vid',
            'videoId',
            'reference_vid',
            'referenceVid',
            'fp_ref_id',
            'fpRefId'
        ]);

        if (vid && looksLikeAudioTrack(value)) {
            const metadata = getTrackMetadata(value, ancestors);
            const url = DOWNLOAD_HOST + encodeURIComponent(vid);

            addItem(items, seen, {
                url,
                title: metadata.title,
                artist: metadata.artist,
                year: metadata.year,
                genre: metadata.genre,
                mood: metadata.mood,
                filename: buildFilename(metadata, url)
            });
        }

        Object.keys(value).forEach(function (key) {
            collectFromJson(value[key], items, seen, visited, nextAncestors);
        });
    }

    function addItem(items, seen, item) {
        if (!item || !item.url) {
            return;
        }

        item.url = cleanUrl(item.url);

        if (!isDownloadUrl(item.url)) {
            return;
        }

        item.filename = item.filename || buildFilename(item);

        if (seen.has(item.url)) {
            mergeExistingItem(items, item);
            return;
        }

        seen.add(item.url);
        items.push(item);
    }

    function mergeExistingItem(items, item) {
        const existing = items.find(function (candidate) {
            return candidate.url === item.url;
        });

        if (!existing) {
            return;
        }

        if (!existing.title && item.title) {
            existing.title = item.title;
        }

        if (!existing.artist && item.artist) {
            existing.artist = item.artist;
        }

        if (!existing.year && item.year) {
            existing.year = item.year;
        }

        if (!existing.genre && item.genre) {
            existing.genre = item.genre;
        }

        if (!existing.mood && item.mood) {
            existing.mood = item.mood;
        }

        if (!existing.filename && item.filename) {
            existing.filename = item.filename;
        }
    }

    function extractDownloadUrls(text) {
        const urls = [];
        let match;

        DOWNLOAD_URL_PATTERN.lastIndex = 0;

        while ((match = DOWNLOAD_URL_PATTERN.exec(text)) !== null) {
            urls.push(cleanUrl(match[0]));
        }

        return urls;
    }

    function cleanUrl(url) {
        return String(url || '')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/[\\]+$/g, '');
    }

    function isDownloadUrl(url) {
        const cleanedUrl = cleanUrl(url);

        return /^https?:\/\/(?:www\.)?youtube\.com\/audiolibrary_download\?/i.test(cleanedUrl) ||
            /^https?:\/\/[^/]*googlevideo\.com\/videoplayback\?/i.test(cleanedUrl) ||
            /[?&]mime=audio/i.test(cleanedUrl) ||
            /\.(mp3|wav|m4a|aac|ogg)(\?|#|$)/i.test(cleanedUrl);
    }

    function getFirstString(object, keys) {
        for (const key of keys) {
            if (typeof object[key] === 'string' && object[key]) {
                return object[key];
            }
        }

        return '';
    }

    function getFirstNestedString(object, paths) {
        for (const path of paths) {
            const value = getPathValue(object, path);

            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }

            const formatted = getFormattedText(value);

            if (formatted) {
                return formatted;
            }
        }

        return '';
    }

    function getPathValue(object, path) {
        return path.split('.').reduce(function (value, key) {
            if (!value || typeof value !== 'object') {
                return undefined;
            }

            return value[key];
        }, object);
    }

    function looksLikeAudioTrack(object) {
        if (!object || typeof object !== 'object') {
            return false;
        }

        if (object.downloadable === true || object.streamid || object.license_type !== undefined || object.licenseType !== undefined) {
            return true;
        }

        return Boolean(
            getFirstString(object, ['title', 'trackTitle', 'name']) &&
            (getFirstString(object, ['artist', 'artistName']) || object.len !== undefined || object.duration !== undefined)
        );
    }

    function buildFilename(object, url) {
        const metadata = getTrackMetadata(object || {}, []);
        const title = metadata.title;
        const artist = metadata.artist;
        const year = metadata.year;
        const genre = metadata.genre;
        const mood = metadata.mood;
        const extension = getExtensionFromUrl(url) || 'mp3';
        const parts = [artist, title].filter(Boolean);

        if (!parts.length) {
            return '';
        }

        const base = parts.join(' - ') + (year ? ` (${year})` : '') + (genre ? ` (${genre})` : '') + (mood ? ` (${mood})` : '');
        return sanitizeFilename(`${base}.${extension}`);
    }

    function getTrackMetadata(object, ancestors) {
        const contexts = [object].concat((ancestors || []).slice().reverse());

        return {
            title: getFirstContextValue(contexts, getTrackTitle),
            artist: getFirstContextValue(contexts, getTrackArtist),
            year: getFirstContextValue(contexts, getTrackYear),
            genre: getFirstContextValue(contexts, getTrackGenre),
            mood: getFirstContextValue(contexts, getTrackMood)
        };
    }

    function getFirstContextValue(contexts, getter) {
        for (const context of contexts) {
            const value = getter(context);

            if (value) {
                return value;
            }
        }

        return '';
    }

    function getTrackTitle(object) {
        return getFirstNestedString(object, [
            'title',
            'trackTitle',
            'videoTitle',
            'name',
            'displayTitle',
            'displayData.title',
            'music.displayData.title',
            'metadata.title',
            'trackMetadata.title',
            'audioTrackData.title',
            'song.title',
            'videoData.title',
            'content.title'
        ]);
    }

    function getTrackArtist(object) {
        const directArtist = getFirstNestedString(object, [
            'artist',
            'artistName',
            'artists',
            'artistsText',
            'artistDisplayName',
            'displayData.artist',
            'displayData.artistName',
            'displayData.artistsText',
            'music.displayData.artist',
            'music.displayData.artistName',
            'metadata.artist',
            'metadata.artistName',
            'trackMetadata.artist',
            'trackMetadata.artistName',
            'audioTrackData.artist',
            'videoData.artist',
            'videoData.artistName',
            'song.artist'
        ]);

        if (directArtist) {
            return directArtist;
        }

        return getArtistNamesFromArrays(object);
    }

    function getTrackYear(object) {
        return getFirstYearFromPaths(object, [
            'year',
            'releaseYear',
            'release_year',
            'recordingYear',
            'copyrightYear',
            'date',
            'publishTime',
            'publishedTime',
            'publishedTimeText',
            'dateAdded',
            'added',
            'addedDate',
            'releaseDate',
            'release_date',
            'displayData.year',
            'displayData.releaseYear',
            'displayData.releaseDate',
            'displayData.date',
            'displayData.publishTime',
            'music.displayData.year',
            'music.displayData.releaseYear',
            'music.displayData.releaseDate',
            'metadata.year',
            'metadata.releaseYear',
            'metadata.releaseDate',
            'metadata.publishTime',
            'trackMetadata.year',
            'trackMetadata.releaseYear',
            'trackMetadata.releaseDate',
            'trackMetadata.publishTime'
        ]);
    }

    function getTrackGenre(object) {
        const directGenre = getFirstGenreFromPaths(object, [
            'genre',
            'genreName',
            'genresText',
            'attributes.genres',
            'attributes.genre',
            'displayData.genre',
            'displayData.genreName',
            'music.displayData.genre',
            'metadata.genre',
            'metadata.genreName',
            'trackMetadata.genre',
            'trackMetadata.genreName',
            'audioTrackData.genre'
        ]);

        if (directGenre) {
            return directGenre;
        }

        return getGenreFromArrays(object);
    }

    function getTrackMood(object) {
        const directMood = getFirstMoodFromPaths(object, [
            'mood',
            'moodName',
            'moodsText',
            'attributes.moods',
            'attributes.mood',
            'displayData.mood',
            'displayData.moodName',
            'music.displayData.mood',
            'metadata.mood',
            'metadata.moodName',
            'trackMetadata.mood',
            'trackMetadata.moodName',
            'audioTrackData.mood'
        ]);

        if (directMood) {
            return directMood;
        }

        return getMoodFromArrays(object);
    }

    function getFirstYearFromPaths(object, paths) {
        for (const path of paths) {
            const year = extractYear(getPathValue(object, path));

            if (year) {
                return year;
            }
        }

        return '';
    }

    function getFirstGenreFromPaths(object, paths) {
        for (const path of paths) {
            const genre = normalizeGenre(getPathValue(object, path));

            if (genre) {
                return genre;
            }
        }

        return '';
    }

    function getFirstMoodFromPaths(object, paths) {
        for (const path of paths) {
            const mood = normalizeMood(getPathValue(object, path));

            if (mood) {
                return mood;
            }
        }

        return '';
    }

    function getGenreFromArrays(object) {
        const arrays = [
            getPathValue(object, 'attributes'),
            getPathValue(object, 'genres'),
            getPathValue(object, 'displayData.genres'),
            getPathValue(object, 'music.displayData.genres'),
            getPathValue(object, 'metadata.genres'),
            getPathValue(object, 'trackMetadata.genres'),
            getPathValue(object, 'audioTrackData.genres')
        ];

        for (const value of arrays) {
            const genre = normalizeGenre(value);

            if (genre) {
                return genre;
            }
        }

        return '';
    }

    function getMoodFromArrays(object) {
        const arrays = [
            getPathValue(object, 'attributes'),
            getPathValue(object, 'moods'),
            getPathValue(object, 'displayData.moods'),
            getPathValue(object, 'music.displayData.moods'),
            getPathValue(object, 'metadata.moods'),
            getPathValue(object, 'trackMetadata.moods'),
            getPathValue(object, 'audioTrackData.moods')
        ];

        for (const value of arrays) {
            const mood = normalizeMood(value);

            if (mood) {
                return mood;
            }
        }

        return '';
    }

    function normalizeGenre(value) {
        if (typeof value === 'string') {
            return formatCreatorMusicLabel(value);
        }

        if (!value || typeof value !== 'object') {
            return '';
        }

        if (Array.isArray(value)) {
            const genres = value.map(normalizeGenre).filter(Boolean);
            return genres.length ? Array.from(new Set(genres)).join(', ') : '';
        }

        const nestedGenre = getFirstGenreFromPaths(value, [
            'genres',
            'genre',
            'genreName',
            'displayGenre',
            'displayData.genre',
            'metadata.genre'
        ]);

        if (nestedGenre) {
            return nestedGenre;
        }

        const label = getFirstNestedString(value, [
                'genre',
                'genreName',
                'name',
                'displayName',
                'title',
                'text',
                'label',
                'value',
                'displayText'
        ]);

        return formatCreatorMusicLabel(label);
    }

    function normalizeMood(value) {
        if (typeof value === 'string') {
            return formatCreatorMusicLabel(value);
        }

        if (!value || typeof value !== 'object') {
            return '';
        }

        if (Array.isArray(value)) {
            const moods = value.map(normalizeMood).filter(Boolean);
            return moods.length ? Array.from(new Set(moods)).join(', ') : '';
        }

        const nestedMood = getFirstMoodFromPaths(value, [
            'moods',
            'mood',
            'moodName',
            'displayMood',
            'displayData.mood',
            'metadata.mood'
        ]);

        if (nestedMood) {
            return nestedMood;
        }

        const label = getFirstNestedString(value, [
            'mood',
            'moodName',
            'name',
            'displayName',
            'title',
            'text',
            'label',
            'value',
            'displayText'
        ]);

        return formatCreatorMusicLabel(label);
    }

    function formatCreatorMusicLabel(value) {
        let text = String(value || '').trim();

        if (!text) {
            return '';
        }

        text = text
            .replace(/^CREATOR_MUSIC_(GENRE|MOOD|INSTRUMENT)_/i, '')
            .replace(/^CREATOR_MUSIC_/i, '');

        if (text.indexOf('_') === -1 && !/^[A-Z0-9_]+$/.test(text)) {
            return text;
        }

        return text
            .split('_')
            .filter(Boolean)
            .map(function (word) {
                const normalized = word.toLowerCase();

                if (normalized === 'and') {
                    return '&';
                }

                if (normalized === 'r') {
                    return 'R';
                }

                if (normalized === 'b') {
                    return 'B';
                }

                if (normalized === 'childrens') {
                    return "Children's";
                }

                return normalized.charAt(0).toUpperCase() + normalized.slice(1);
            })
            .join(' ')
            .replace(/\bR & B\b/g, 'R&B')
            .replace(/\s*&\s*/g, ' & ')
            .trim();
    }

    function getArtistNamesFromArrays(object) {
        const arrays = [
            getPathValue(object, 'artists'),
            getPathValue(object, 'artist'),
            getPathValue(object, 'displayData.artists'),
            getPathValue(object, 'music.displayData.artists'),
            getPathValue(object, 'metadata.artists'),
            getPathValue(object, 'trackMetadata.artists'),
            getPathValue(object, 'audioTrackData.artists')
        ];

        for (const value of arrays) {
            const artistNames = normalizeArtistNames(value);

            if (artistNames) {
                return artistNames;
            }
        }

        return '';
    }

    function normalizeArtistNames(value) {
        if (typeof value === 'string') {
            return value.trim();
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return getFirstNestedString(value, [
                'name',
                'artistName',
                'displayName',
                'title',
                'text',
                'label',
                'channelTitle',
                'artist.displayName',
                'artist.name'
            ]);
        }

        if (!Array.isArray(value)) {
            return '';
        }

        const names = value
            .map(function (entry) {
                if (typeof entry === 'string') {
                    return entry;
                }

                return getFirstNestedString(entry, [
                    'name',
                    'artistName',
                    'displayName',
                    'title',
                    'text',
                    'label',
                    'channelTitle',
                    'artist.displayName',
                    'artist.name'
                ]);
            })
            .filter(Boolean);

        return Array.from(new Set(names)).join(', ');
    }

    function getFormattedText(value) {
        if (!value || typeof value !== 'object') {
            return '';
        }

        if (typeof value.simpleText === 'string') {
            return value.simpleText.trim();
        }

        if (Array.isArray(value.runs)) {
            return value.runs
                .map(function (run) {
                    return run && typeof run.text === 'string' ? run.text : '';
                })
                .join('')
                .trim();
        }

        return '';
    }

    function sanitizeFilename(filename) {
        return filename
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    function normalizedText(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractYear(value) {
        if (value && typeof value === 'object') {
            const formatted = getFormattedText(value);
            const formattedYear = extractYear(formatted);

            if (formattedYear) {
                return formattedYear;
            }

            const directYear = getFirstNestedString(value, [
                'year',
                'releaseYear',
                'date',
                'formatted',
                'formattedDate',
                'simpleText'
            ]);
            const directYearMatch = extractYear(directYear);

            if (directYearMatch) {
                return directYearMatch;
            }

            const seconds = Number(value.seconds || value.timeSeconds || value.timestampSeconds);

            if (Number.isFinite(seconds) && seconds > 0) {
                return String(new Date(seconds * 1000).getUTCFullYear());
            }

            const millis = Number(value.millis || value.timeMillis || value.timestampMillis);

            if (Number.isFinite(millis) && millis > 0) {
                return String(new Date(millis).getUTCFullYear());
            }

            return '';
        }

        const numeric = String(value || '').trim();

        if (/^\d{10}$/.test(numeric)) {
            return String(new Date(Number(numeric) * 1000).getUTCFullYear());
        }

        if (/^\d{13}$/.test(numeric)) {
            return String(new Date(Number(numeric)).getUTCFullYear());
        }

        const match = String(value || '').match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : '';
    }

    function getExtensionFromUrl(url) {
        const cleanedUrl = cleanUrl(url);
        const pathMatch = cleanedUrl.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);

        if (pathMatch) {
            return pathMatch[1].toLowerCase();
        }

        const mimeMatch = cleanedUrl.match(/[?&]mime=audio%2F([^&]+)/i) || cleanedUrl.match(/[?&]mime=audio\/([^&]+)/i);

        if (mimeMatch) {
            const subtype = decodeURIComponent(mimeMatch[1]).toLowerCase();

            if (subtype.indexOf('mp4') !== -1) {
                return 'm4a';
            }

            if (subtype.indexOf('mpeg') !== -1 || subtype.indexOf('mp3') !== -1) {
                return 'mp3';
            }

            if (subtype.indexOf('webm') !== -1) {
                return 'webm';
            }
        }

        return '';
    }

    function parseJson(text) {
        const cleaned = text
            .replace(/^\)\]\}'\s*/, '')
            .trim();

        if (!cleaned || (cleaned[0] !== '{' && cleaned[0] !== '[')) {
            return null;
        }

        try {
            return JSON.parse(cleaned);
        } catch (error) {
            return null;
        }
    }

    function hydrateCreatorMusicDownloadUrls(url, requestMeta, responseJson) {
        if (!/\/creator_music\/list_tracks/i.test(String(url || ''))) {
            return;
        }

        const requestJson = parseJson(requestMeta && requestMeta.bodyText);
        const trackIds = collectTrackIds(responseJson);
        const channelId = requestJson && requestJson.channelId;
        const context = requestJson && requestJson.context;

        if (!trackIds.length || !channelId || !context) {
            return;
        }

        const missingTrackIds = trackIds.filter(function (trackId) {
            if (hydratedTrackIds.has(trackId)) {
                return false;
            }

            hydratedTrackIds.add(trackId);
            return true;
        });

        if (!missingTrackIds.length) {
            return;
        }

        const requestUrl = buildCreatorMusicGetTracksUrl(url);

        if (!requestUrl) {
            return;
        }

        const headers = buildJsonHeaders(requestMeta && requestMeta.headers);

        window.fetch(requestUrl, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
                context,
                trackIds: missingTrackIds,
                channelId,
                mask: {
                    includeDownloadUrl: true
                }
            })
        })
            .then(function (response) {
                return response.text();
            })
            .then(function (text) {
                inspectResponseText(requestUrl, text, {
                    bodyText: '',
                    headers
                });
            })
            .catch(function () {
                missingTrackIds.forEach(function (trackId) {
                    hydratedTrackIds.delete(trackId);
                });
            });
    }

    function rememberListTracksRequest(url, requestMeta, responseJson) {
        if (!/\/creator_music\/list_tracks/i.test(String(url || ''))) {
            return;
        }

        const requestJson = parseJson(requestMeta && requestMeta.bodyText);

        if (!requestJson || !requestJson.context || !requestJson.channelId) {
            return;
        }

        latestListTracksRequest = {
            url,
            headers: Object.assign({}, requestMeta && requestMeta.headers),
            requestJson,
            responseJson
        };
    }

    function onCollectAllRequest(event) {
        const requestId = event.detail && event.detail.requestId;
        const options = event.detail && event.detail.options || {};

        if (collectionInProgress) {
            dispatchCollectionError(requestId, 'Collection is already in progress.');
            return;
        }

        collectionInProgress = true;
        collectAllMusicTracks(requestId, options)
            .catch(function (error) {
                dispatchCollectionError(requestId, error && error.message ? error.message : String(error));
            })
            .finally(function () {
                collectionInProgress = false;
            });
    }

    async function collectAllMusicTracks(requestId, options) {
        if (!latestListTracksRequest) {
            throw new Error('YouTube Studio music API request was not captured yet. Reload the YouTube Studio page and try again.');
        }

        options = options || {};

        const listUrl = latestListTracksRequest.url;
        const getTracksUrl = buildCreatorMusicGetTracksUrl(listUrl);
        const headers = buildJsonHeaders(latestListTracksRequest.headers);
        const baseRequest = cloneJson(latestListTracksRequest.requestJson);
        const channelId = baseRequest.channelId;
        const context = baseRequest.context;
        const pageLimit = normalizePositiveInteger(options.pageLimit);
        const samplePerPage = normalizePositiveInteger(options.samplePerPage);
        const collectedTracks = [];
        const seenTrackIds = new Set();
        let pageToken = '';
        let pageIndex = 0;
        let totalSize = 0;

        if (!getTracksUrl) {
            throw new Error('Could not build the YouTube Studio download API URL.');
        }

        if (options.currentPageOnly) {
            const currentPageResponse = await postJson(listUrl, buildCurrentPageRequest(baseRequest), headers);
            const tracks = getListTracks(currentPageResponse);
            const tracksToCollect = samplePerPage ? tracks.slice(0, samplePerPage) : tracks;

            tracksToCollect.forEach(function (track) {
                const trackId = getTrackId(track);

                if (!trackId || seenTrackIds.has(trackId)) {
                    return;
                }

                seenTrackIds.add(trackId);
                collectedTracks.push(track);
            });

            totalSize = collectedTracks.length;
            dispatchCollectionProgress(requestId, {
                stage: 'collecting-current',
                collected: collectedTracks.length,
                total: collectedTracks.length
            });
        } else {
            do {
                pageIndex += 1;

                const pageRequest = buildPagedListRequest(baseRequest, pageToken);
                const pageResponse = await postJson(listUrl, pageRequest, headers);

                if (!totalSize) {
                    totalSize = getTotalSize(pageResponse);
                }

                const tracks = getListTracks(pageResponse);
                const tracksToCollect = samplePerPage ? tracks.slice(0, samplePerPage) : tracks;

                tracksToCollect.forEach(function (track) {
                    const trackId = getTrackId(track);

                    if (!trackId || seenTrackIds.has(trackId)) {
                        return;
                    }

                    seenTrackIds.add(trackId);
                    collectedTracks.push(track);
                });

                dispatchCollectionProgress(requestId, {
                    stage: 'collecting',
                    page: pageIndex,
                    collected: collectedTracks.length,
                    total: totalSize || collectedTracks.length
                });

                pageToken = getNextPageToken(pageResponse);
            } while (pageToken && (!pageLimit || pageIndex < pageLimit));
        }

        const downloads = [];
        const downloadSeen = new Set();

        for (let index = 0; index < collectedTracks.length; index += DOWNLOAD_LOOKUP_BATCH_SIZE) {
            const batch = collectedTracks.slice(index, index + DOWNLOAD_LOOKUP_BATCH_SIZE);
            const trackIds = batch.map(getTrackId).filter(Boolean);
            const hydratedTracks = await fetchDownloadTracksForIds(getTracksUrl, context, channelId, trackIds, headers);
            const metadataById = buildTrackMetadataMap(batch);

            hydratedTracks.forEach(function (lookupResult, trackIndex) {
                const track = lookupResult.track;
                const trackId = getTrackId(track) || lookupResult.trackId || trackIds[trackIndex] || getTrackId(batch[trackIndex]);
                const fallbackTrack = findTrackById(batch, trackId) || batch[trackIndex];
                const fallbackMetadata = metadataById.get(trackId) || getTrackMetadata(fallbackTrack, []);
                const downloadUrl = getDownloadUrlFromTrack(track);

                if (!downloadUrl || downloadSeen.has(downloadUrl)) {
                    return;
                }

                const metadata = mergeMetadata(
                    fallbackMetadata,
                    getTrackMetadata(track, [])
                );
                const item = {
                    trackId,
                    url: cleanUrl(downloadUrl),
                    title: metadata.title,
                    artist: metadata.artist,
                    year: metadata.year,
                    genre: metadata.genre,
                    mood: metadata.mood,
                    filename: buildFilename(metadata, downloadUrl)
                };

                if (options.debug) {
                    item.debug = {
                        trackId,
                        listTrack: summarizeTrackForDebug(fallbackTrack),
                        downloadTrack: summarizeTrackForDebug(track),
                        fallbackMetadata,
                        hydratedMetadata: getTrackMetadata(track, [])
                    };
                }

                downloadSeen.add(downloadUrl);
                downloads.push(item);
            });

            dispatchCollectionProgress(requestId, {
                stage: 'preparing',
                prepared: downloads.length,
                collected: collectedTracks.length,
                total: totalSize || collectedTracks.length
            });
        }

        dispatchDownloadItems(downloads);
        window.dispatchEvent(new CustomEvent(COLLECT_ALL_COMPLETE_EVENT, {
            detail: {
                requestId,
                items: downloads,
                total: totalSize || collectedTracks.length,
                sampled: Boolean(samplePerPage || pageLimit),
                currentPageOnly: Boolean(options.currentPageOnly)
            }
        }));
    }

    function normalizePositiveInteger(value) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    }

    function findTrackById(tracks, trackId) {
        if (!trackId) {
            return null;
        }

        return tracks.find(function (track) {
            return getTrackId(track) === trackId;
        }) || null;
    }

    function summarizeTrackForDebug(track) {
        if (!track || typeof track !== 'object') {
            return {};
        }

        return {
            keys: Object.keys(track).slice(0, 40),
            trackId: getTrackId(track),
            title: getTrackTitle(track),
            artist: getTrackArtist(track),
            year: getTrackYear(track),
            genre: getTrackGenre(track),
            mood: getTrackMood(track),
            interestingFields: getInterestingFields(track)
        };
    }

    function getInterestingFields(track) {
        const fields = {};
        const paths = [
            'title',
            'trackTitle',
            'videoTitle',
            'artist',
            'artistName',
            'artists',
            'genre',
            'genreName',
            'genres',
            'mood',
            'moodName',
            'moods',
            'attributes',
            'displayData.title',
            'displayData.artist',
            'displayData.artistName',
            'displayData.genre',
            'displayData.mood',
            'metadata.title',
            'metadata.artist',
            'metadata.artistName',
            'metadata.artists',
            'metadata.genre',
            'metadata.mood',
            'releaseDate',
            'publishTime',
            'publishedTime',
            'date',
            'dateAdded',
            'displayData.date',
            'displayData.publishTime',
            'metadata.releaseDate'
        ];

        paths.forEach(function (path) {
            const value = getPathValue(track, path);
            const normalized = normalizeDebugValue(value);

            if (normalized) {
                fields[path] = normalized;
            }
        });

        return fields;
    }

    function normalizeDebugValue(value) {
        if (typeof value === 'string') {
            return value.slice(0, 180);
        }

        const formatted = getFormattedText(value);

        if (formatted) {
            return formatted.slice(0, 180);
        }

        const artistNames = normalizeArtistNames(value);

        if (artistNames) {
            return artistNames.slice(0, 180);
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }

        try {
            return JSON.stringify(value).slice(0, 240);
        } catch (error) {
            return '';
        }

        return '';
    }

    function buildPagedListRequest(baseRequest, pageToken) {
        const request = cloneJson(baseRequest);

        request.pageInfo = Object.assign({}, request.pageInfo, {
            pageSize: PAGE_SIZE
        });

        delete request.pageInfo.firstItemIndex;
        delete request.pageInfo.offset;
        delete request.pageInfo.startIndex;

        if (pageToken) {
            request.pageInfo.pageToken = pageToken;
        } else {
            delete request.pageInfo.pageToken;
        }

        delete request.pageToken;
        return request;
    }

    function buildCurrentPageRequest(baseRequest) {
        const request = cloneJson(baseRequest);

        request.pageInfo = Object.assign({}, request.pageInfo, {
            pageSize: PAGE_SIZE
        });

        return request;
    }

    async function fetchDownloadTracksForIds(getTracksUrl, context, channelId, trackIds, headers) {
        const results = await requestDownloadTracks(getTracksUrl, context, channelId, trackIds, headers);
        const returnedIds = new Set(results.map(function (result) {
            return result.trackId;
        }).filter(Boolean));
        const missingTrackIds = trackIds.filter(function (trackId) {
            return trackId && !returnedIds.has(trackId);
        });

        if (!missingTrackIds.length || trackIds.length <= DOWNLOAD_LOOKUP_RETRY_BATCH_SIZE) {
            return results;
        }

        for (let index = 0; index < missingTrackIds.length; index += DOWNLOAD_LOOKUP_RETRY_BATCH_SIZE) {
            const retryIds = missingTrackIds.slice(index, index + DOWNLOAD_LOOKUP_RETRY_BATCH_SIZE);
            const retryResults = await requestDownloadTracks(getTracksUrl, context, channelId, retryIds, headers);

            retryResults.forEach(function (result) {
                if (result.trackId) {
                    returnedIds.add(result.trackId);
                }

                results.push(result);
            });
        }

        return results;
    }

    async function requestDownloadTracks(getTracksUrl, context, channelId, trackIds, headers) {
        if (!trackIds.length) {
            return [];
        }

        const downloadResponse = await postJson(getTracksUrl, {
            context,
            trackIds,
            channelId,
            mask: {
                includeDownloadUrl: true
            }
        }, headers);

        return getDownloadTracks(downloadResponse).map(function (track, index) {
            return {
                track,
                trackId: getTrackId(track) || trackIds[index] || ''
            };
        });
    }

    function postJson(url, body, headers) {
        return window.fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: buildJsonHeaders(headers),
            body: JSON.stringify(body)
        }).then(function (response) {
            if (!response.ok) {
                throw new Error(`YouTube Studio API failed with HTTP ${response.status}.`);
            }

            return response.text();
        }).then(function (text) {
            const json = parseJson(text);

            if (!json) {
                throw new Error('YouTube Studio API returned an unreadable response.');
            }

            return json;
        });
    }

    function buildJsonHeaders(headers) {
        const result = {};
        let contentType = '';

        Object.keys(headers || {}).forEach(function (key) {
            const value = headers[key];
            const lowerKey = String(key).toLowerCase();

            if (lowerKey === 'content-type') {
                contentType = value;
                return;
            }

            if (isForbiddenRequestHeader(lowerKey)) {
                return;
            }

            result[key] = value;
        });

        result['content-type'] = contentType || 'application/json';
        return result;
    }

    function isForbiddenRequestHeader(lowerKey) {
        return FORBIDDEN_REQUEST_HEADERS.has(lowerKey) ||
            lowerKey.indexOf('proxy-') === 0 ||
            lowerKey.indexOf('sec-') === 0;
    }

    function getListTracks(response) {
        if (!response || typeof response !== 'object') {
            return [];
        }

        if (Array.isArray(response.tracks)) {
            return response.tracks;
        }

        return [];
    }

    function getDownloadTracks(response) {
        return getListTracks(response);
    }

    function getTrackId(track) {
        return getFirstNestedString(track || {}, [
            'trackId',
            'artTrackVideoId',
            'videoId',
            'id',
            'sourceExternalVideoId',
            'videoData.sourceExternalVideoId',
            'music.artTrackVideoId'
        ]);
    }

    function getDownloadUrlFromTrack(track) {
        return getFirstString(track || {}, [
            'downloadAudioUrl',
            'download_audio_url',
            'downloadUrl',
            'download_url',
            'downloadUri',
            'url'
        ]);
    }

    function buildTrackMetadataMap(tracks) {
        const map = new Map();

        tracks.forEach(function (track) {
            const trackId = getTrackId(track);

            if (!trackId) {
                return;
            }

            map.set(trackId, getTrackMetadata(track, []));
        });

        return map;
    }

    function mergeMetadata(primary, fallback) {
        return {
            title: primary.title || fallback.title || '',
            artist: primary.artist || fallback.artist || '',
            year: primary.year || fallback.year || '',
            genre: primary.genre || fallback.genre || '',
            mood: primary.mood || fallback.mood || ''
        };
    }

    function getTotalSize(response) {
        const size = getPathValue(response || {}, 'pageInfo.totalSizeInfo.size') ||
            getPathValue(response || {}, 'pageInfo.totalSize') ||
            getPathValue(response || {}, 'totalSizeInfo.size') ||
            getPathValue(response || {}, 'totalSize');
        const parsed = Number(size);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    function getNextPageToken(response) {
        return getFirstNestedString(response || {}, [
            'pageInfo.nextPageToken',
            'nextPageToken',
            'continuationToken'
        ]);
    }

    function dispatchDownloadItems(items) {
        if (!items.length) {
            return;
        }

        window.dispatchEvent(new CustomEvent(EVENT_NAME, {
            detail: { items }
        }));
    }

    function dispatchCollectionProgress(requestId, detail) {
        window.dispatchEvent(new CustomEvent(COLLECT_ALL_PROGRESS_EVENT, {
            detail: Object.assign({ requestId }, detail)
        }));
    }

    function dispatchCollectionError(requestId, message) {
        window.dispatchEvent(new CustomEvent(COLLECT_ALL_ERROR_EVENT, {
            detail: {
                requestId,
                message
            }
        }));
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function collectTrackIds(value, ids, visited) {
        ids = ids || [];
        visited = visited || new Set();

        if (!value || typeof value !== 'object' || visited.has(value)) {
            return ids;
        }

        visited.add(value);

        if (Array.isArray(value)) {
            value.forEach(function (entry) {
                collectTrackIds(entry, ids, visited);
            });
            return ids;
        }

        if (typeof value.trackId === 'string' && value.trackId) {
            ids.push(value.trackId);
        }

        Object.keys(value).forEach(function (key) {
            collectTrackIds(value[key], ids, visited);
        });

        return Array.from(new Set(ids));
    }

    function buildCreatorMusicGetTracksUrl(url) {
        try {
            const parsed = new URL(url, location.origin);
            parsed.pathname = parsed.pathname.replace(/\/creator_music\/list_tracks$/i, '/creator_music/get_tracks');
            return parsed.href;
        } catch (error) {
            return '';
        }
    }

    function isLikelyRelevantUrl(url) {
        return /studio\.youtube\.com|youtubei\/v1\/creator|audio|music|library/i.test(String(url || ''));
    }

    function isLikelyRelevantText(text) {
        return /audiolibrary_download|download_url|downloadUrl|downloadAudioUrl|audioLibrary|AUDIO_LIBRARY|creatorAudio|audio_track|audioTrack|trackId/i.test(String(text || '').slice(0, MAX_TEXT_LENGTH));
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') {
            return input;
        }

        if (input && typeof input.url === 'string') {
            return input.url;
        }

        return '';
    }

    function getFetchRequestMeta(input, init) {
        return {
            url: getRequestUrl(input),
            bodyText: bodyToText(init && init.body),
            headers: getFetchHeaders(input, init)
        };
    }

    function getFetchHeaders(input, init) {
        const headers = {};

        appendHeaders(headers, input && input.headers);
        appendHeaders(headers, init && init.headers);

        return headers;
    }

    function appendHeaders(target, headers) {
        if (!headers) {
            return;
        }

        if (typeof headers.forEach === 'function') {
            headers.forEach(function (value, key) {
                target[key] = value;
            });
            return;
        }

        if (Array.isArray(headers)) {
            headers.forEach(function (entry) {
                target[entry[0]] = entry[1];
            });
            return;
        }

        Object.keys(headers).forEach(function (key) {
            target[key] = headers[key];
        });
    }

    function bodyToText(body) {
        if (typeof body === 'string') {
            return body;
        }

        if (!body) {
            return '';
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        return '';
    }
})();
