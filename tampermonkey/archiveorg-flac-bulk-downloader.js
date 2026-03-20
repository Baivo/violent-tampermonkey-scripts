// ==UserScript==
// @name         Archive.org FLAC Bulk Downloader
// @namespace    https://github.com/Baivo/violent-tampermonkey-scripts
// @version      1.0
// @description  One-click bulk download of all FLAC files from any archive.org download page
// @author       Baivo
// @match        https://archive.org/download/*
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    var cancelRequested = false;
    var activeHandles   = [];
    var isRunning       = false;
    var failedFiles     = [];
    var concurrency     = GM_getValue('concurrency', 3);

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function albumFromURL() {
        var path = decodeURIComponent(window.location.pathname).replace(/\/$/, '');
        var parts = path.split('/');
        return parts[parts.length - 1] || 'unknown-album';
    }

    function getFlacLinks() {
        var anchors = document.querySelectorAll('a[href]');
        var seen = {};
        var results = [];
        for (var i = 0; i < anchors.length; i++) {
            var href = anchors[i].href;
            if (!href) continue;
            if (href.toLowerCase().endsWith('.flac') && !seen[href]) {
                seen[href] = true;
                results.push({
                    url: href,
                    filename: decodeURIComponent(href.split('/').pop())
                });
            }
        }
        return results;
    }

    function buildSavePath(root, album) {
        root  = (root  || '').trim().replace(/\\+$/, '');
        album = (album || '').trim();
        if (root && album) return root + '\\' + album;
        return root || album || 'FLAC';
    }

    function fmtSpeed(bps) {
        if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
        if (bps >= 1024)    return (bps / 1024).toFixed(0)    + ' KB/s';
        return bps.toFixed(0) + ' B/s';
    }

    function fmtEta(secs) {
        if (!isFinite(secs) || secs < 0) return '';
        if (secs < 60)   return Math.ceil(secs) + 's';
        if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (Math.ceil(secs) % 60) + 's';
        return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------
    var styleEl = document.createElement('style');
    styleEl.textContent = [
        '#flac-dl-btn {',
        '  position: fixed; bottom: 24px; right: 24px; z-index: 99999;',
        '  background: #161616; color: #e0e0e0;',
        '  border: 1.5px solid #404040; border-radius: 6px;',
        '  padding: 9px 16px;',
        '  font: 700 12px/1 "Courier New", monospace; letter-spacing: 0.05em;',
        '  cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.5);',
        '  transition: background 0.12s, border-color 0.12s;',
        '  user-select: none;',
        '}',
        '#flac-dl-btn:hover { background: #252525; border-color: #777; color: #fff; }',

        '#flac-dl-panel {',
        '  position: fixed; bottom: 70px; right: 24px; z-index: 99999;',
        '  width: 430px; background: #0f0f0f;',
        '  border: 1.5px solid #333; border-radius: 8px;',
        '  font: 12px/1.5 "Courier New", monospace; color: #bbb;',
        '  box-shadow: 0 10px 40px rgba(0,0,0,0.7);',
        '  overflow: hidden; display: none;',
        '}',

        '#flac-dl-header {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  padding: 9px 14px; background: #181818; border-bottom: 1px solid #303030;',
        '}',
        '#flac-dl-header-title { font-weight: 700; color: #fff; font-size: 11px; letter-spacing: 0.08em; }',
        '#flac-dl-header-close { background: none; border: none; color: #888; font-size: 15px; cursor: pointer; line-height: 1; padding: 0; }',
        '#flac-dl-header-close:hover { color: #fff; }',

        '#flac-dl-path-section { padding: 10px 14px; border-bottom: 1px solid #242424; background: #141414; }',
        '.flac-field { margin-bottom: 8px; }',
        '.flac-field:last-child { margin-bottom: 0; }',
        '.flac-field-label { font-size: 9px; color: #999; letter-spacing: 0.1em; margin-bottom: 4px; }',
        '.flac-field-label em { font-style: normal; color: #606060; margin-left: 6px; }',
        '.flac-field-input {',
        '  width: 100%; box-sizing: border-box;',
        '  background: #222; border: 1px solid #3a3a3a; border-radius: 3px;',
        '  color: #e0e0e0; font: 11px/1 "Courier New", monospace;',
        '  padding: 6px 8px; outline: none;',
        '}',
        '.flac-field-input:focus { border-color: #5a5a5a; background: #272727; }',
        '#flac-dl-album-input { color: #aaa; }',
        '#flac-dl-album-input:focus { color: #e0e0e0; }',
        '#flac-dl-path-preview {',
        '  margin-top: 8px; padding: 5px 7px;',
        '  background: #0e0e0e; border: 1px solid #2a2a2a; border-radius: 3px;',
        '  font-size: 9px; color: #777;',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
        '}',
        '#flac-dl-path-preview b { color: #bbb; font-weight: normal; }',

        '#flac-dl-concurrency-row {',
        '  display: flex; align-items: center; gap: 8px;',
        '  padding: 7px 14px; border-bottom: 1px solid #1e1e1e; background: #111;',
        '}',
        '#flac-dl-concurrency-label { font-size: 9px; color: #888; letter-spacing: 0.08em; white-space: nowrap; }',
        '.flac-conc-btn {',
        '  width: 28px; height: 22px; border-radius: 3px; cursor: pointer;',
        '  font: 700 10px/1 "Courier New", monospace;',
        '  border: 1px solid #353535; background: #1c1c1c; color: #888;',
        '  transition: background 0.1s, color 0.1s, border-color 0.1s;',
        '}',
        '.flac-conc-btn:hover { background: #252525; color: #ccc; border-color: #555; }',
        '.flac-conc-btn.active { background: #1e3528; border-color: #2e5c42; color: #4ec97e; }',

        '#flac-dl-actions { display: flex; gap: 6px; padding: 8px 14px; border-bottom: 1px solid #1a1a1a; }',
        '.flac-act-btn {',
        '  flex: 1; border-radius: 3px; cursor: pointer;',
        '  font: 700 10px/1 "Courier New", monospace; letter-spacing: 0.07em;',
        '  padding: 7px 0; border: 1px solid; transition: background 0.12s;',
        '}',
        '.flac-act-btn:disabled { opacity: 0.3; cursor: not-allowed; }',
        '#flac-dl-start-btn  { background: #1a3528; border-color: #2a5c42; color: #4ec97e; }',
        '#flac-dl-start-btn:not(:disabled):hover { background: #214432; }',
        '#flac-dl-cancel-btn { background: #351a1a; border-color: #5c2a2a; color: #c94e4e; display: none; }',
        '#flac-dl-cancel-btn:not(:disabled):hover { background: #441f1f; }',
        '#flac-dl-retry-btn  { background: #2a2818; border-color: #4e4820; color: #c9b84e; display: none; }',
        '#flac-dl-retry-btn:not(:disabled):hover { background: #343020; }',

        '#flac-dl-overall { padding: 8px 14px 6px; border-bottom: 1px solid #1a1a1a; display: none; }',
        '#flac-dl-overall-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }',
        '#flac-dl-overall-label { color: #bbb; font-size: 10px; }',
        '#flac-dl-overall-pct   { color: #888; font-size: 10px; }',
        '#flac-dl-overall-bar-wrap { background: #1c1c1c; border-radius: 2px; height: 5px; overflow: hidden; }',
        '#flac-dl-overall-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #2a6644, #4ec97e); border-radius: 2px; transition: width 0.3s ease; }',
        '#flac-dl-overall-bar.cancelled { background: linear-gradient(90deg, #6a2a2a, #c94e4e); }',
        '#flac-dl-overall-rate { font-size: 9px; color: #777; margin-top: 4px; }',

        '#flac-dl-log { max-height: 220px; overflow-y: auto; padding: 4px 0; display: none; }',
        '.flac-row { padding: 4px 14px 5px; border-bottom: 1px solid #161616; }',
        '.flac-row:last-child { border-bottom: none; }',
        '.flac-row-top { display: flex; align-items: center; gap: 8px; }',
        '.flac-row-icon   { flex-shrink: 0; width: 12px; font-size: 10px; color: #777; text-align: center; }',
        '.flac-row-name   { flex: 1; font-size: 10px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.flac-row-pct    { flex-shrink: 0; font-size: 9px; color: #777; min-width: 30px; text-align: right; }',
        '.flac-row-status { flex-shrink: 0; font-size: 9px; letter-spacing: 0.04em; min-width: 52px; text-align: right; }',
        '.flac-row-status.s-queued  { color: #666; }',
        '.flac-row-status.s-active  { color: #c9b84e; }',
        '.flac-row-status.s-done    { color: #4ec97e; }',
        '.flac-row-status.s-error   { color: #c94e4e; }',
        '.flac-row-status.s-skipped { color: #777; }',
        '.flac-row-status.s-cancel  { color: #8b4040; }',
        '.flac-row-bar-wrap { height: 2px; background: #1c1c1c; border-radius: 1px; margin-top: 3px; overflow: hidden; }',
        '.flac-row-bar { height: 100%; width: 0%; border-radius: 1px; background: #c9b84e; transition: width 0.15s; }',
        '.flac-row-bar.done  { background: #4ec97e; transition: none; }',
        '.flac-row-bar.error { background: #c94e4e; transition: none; }',
        '.flac-row-meta { display: flex; justify-content: space-between; font-size: 9px; margin-top: 2px; min-height: 11px; }',
        '.flac-row-speed { color: #888; }',
        '.flac-row-eta   { color: #777; }',

        '#flac-dl-footer { padding: 5px 14px; border-top: 1px solid #1a1a1a; color: #666; font-size: 9px; text-align: right; }'
    ].join('\n');
    document.head.appendChild(styleEl);

    // -------------------------------------------------------------------------
    // Build DOM
    // -------------------------------------------------------------------------
    var btn = document.createElement('button');
    btn.id = 'flac-dl-btn';
    btn.textContent = 'FLAC DOWNLOADER';
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'flac-dl-panel';
    panel.innerHTML = [
        '<div id="flac-dl-header">',
        '  <span id="flac-dl-header-title">[ FLAC DOWNLOADER ]</span>',
        '  <button id="flac-dl-header-close">x</button>',
        '</div>',
        '<div id="flac-dl-path-section">',
        '  <div class="flac-field">',
        '    <div class="flac-field-label">ROOT FOLDER <em>persists across pages</em></div>',
        '    <input id="flac-dl-root-input" class="flac-field-input" type="text" spellcheck="false" placeholder="e.g. FLACDL  or  Music\\Archive.org" />',
        '  </div>',
        '  <div class="flac-field">',
        '    <div class="flac-field-label">ALBUM FOLDER <em>auto-updates from URL</em></div>',
        '    <input id="flac-dl-album-input" class="flac-field-input" type="text" spellcheck="false" />',
        '  </div>',
        '  <div id="flac-dl-path-preview">Downloads\\ ...</div>',
        '</div>',
        '<div id="flac-dl-concurrency-row">',
        '  <span id="flac-dl-concurrency-label">PARALLEL DOWNLOADS</span>',
        '  <button class="flac-conc-btn" data-n="1">1</button>',
        '  <button class="flac-conc-btn" data-n="2">2</button>',
        '  <button class="flac-conc-btn" data-n="3">3</button>',
        '  <button class="flac-conc-btn" data-n="4">4</button>',
        '  <button class="flac-conc-btn" data-n="5">5</button>',
        '</div>',
        '<div id="flac-dl-actions">',
        '  <button id="flac-dl-start-btn"  class="flac-act-btn">START</button>',
        '  <button id="flac-dl-cancel-btn" class="flac-act-btn">CANCEL</button>',
        '  <button id="flac-dl-retry-btn"  class="flac-act-btn">RETRY FAILED</button>',
        '</div>',
        '<div id="flac-dl-overall">',
        '  <div id="flac-dl-overall-top">',
        '    <span id="flac-dl-overall-label">0 / 0</span>',
        '    <span id="flac-dl-overall-pct">0%</span>',
        '  </div>',
        '  <div id="flac-dl-overall-bar-wrap"><div id="flac-dl-overall-bar"></div></div>',
        '  <div id="flac-dl-overall-rate"></div>',
        '</div>',
        '<div id="flac-dl-log"></div>',
        '<div id="flac-dl-footer">https://github.com/Baivo/violent-tampermonkey-scripts</div>'
    ].join('');
    document.body.appendChild(panel);

    // Element refs
    var rootInput    = document.getElementById('flac-dl-root-input');
    var albumInput   = document.getElementById('flac-dl-album-input');
    var pathPreview  = document.getElementById('flac-dl-path-preview');
    var startBtn     = document.getElementById('flac-dl-start-btn');
    var cancelBtn    = document.getElementById('flac-dl-cancel-btn');
    var retryBtn     = document.getElementById('flac-dl-retry-btn');
    var overallDiv   = document.getElementById('flac-dl-overall');
    var overallLabel = document.getElementById('flac-dl-overall-label');
    var overallPct   = document.getElementById('flac-dl-overall-pct');
    var overallBar   = document.getElementById('flac-dl-overall-bar');
    var overallRate  = document.getElementById('flac-dl-overall-rate');
    var logDiv       = document.getElementById('flac-dl-log');

    // -------------------------------------------------------------------------
    // Concurrency buttons
    // -------------------------------------------------------------------------
    function setConcurrency(n) {
        concurrency = n;
        GM_setValue('concurrency', n);
        document.querySelectorAll('.flac-conc-btn').forEach(function (b) {
            b.classList.toggle('active', parseInt(b.dataset.n, 10) === n);
        });
    }
    document.querySelectorAll('.flac-conc-btn').forEach(function (b) {
        b.addEventListener('click', function () {
            setConcurrency(parseInt(b.dataset.n, 10));
        });
    });
    setConcurrency(concurrency);

    // -------------------------------------------------------------------------
    // Path preview
    // -------------------------------------------------------------------------
    function updatePreview() {
        var combined = buildSavePath(rootInput.value, albumInput.value);
        pathPreview.innerHTML = 'Downloads\\ <b>' + combined + '</b> \\ *.flac';
    }

    rootInput.addEventListener('input', function () {
        GM_setValue('rootPrefix', rootInput.value);
        updatePreview();
    });

    albumInput.addEventListener('input', function () {
        albumInput.dataset.userEdited = '1';
        updatePreview();
    });

    // -------------------------------------------------------------------------
    // Album field: auto-update on URL change
    // -------------------------------------------------------------------------
    function refreshAlbum() {
        if (!albumInput.dataset.userEdited) {
            albumInput.value = albumFromURL();
            updatePreview();
        }
    }

    var lastHref = location.href;
    new MutationObserver(function () {
        if (location.href !== lastHref) {
            lastHref = location.href;
            albumInput.dataset.userEdited = '';
            refreshAlbum();
            refreshBtn();
        }
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', function () {
        albumInput.dataset.userEdited = '';
        refreshAlbum();
        refreshBtn();
    });

    // -------------------------------------------------------------------------
    // Button label
    // -------------------------------------------------------------------------
    function refreshBtn() {
        var files = getFlacLinks();
        if (files.length > 0 && !isRunning) {
            btn.textContent = 'DOWNLOAD ' + files.length + ' FLAC' + (files.length !== 1 ? 'S' : '');
        }
    }

    // -------------------------------------------------------------------------
    // Panel toggle
    // -------------------------------------------------------------------------
    var panelOpen = false;
    btn.addEventListener('click', function () {
        panelOpen = !panelOpen;
        panel.style.display = panelOpen ? 'block' : 'none';
    });
    document.getElementById('flac-dl-header-close').addEventListener('click', function () {
        panelOpen = false;
        panel.style.display = 'none';
    });

    // -------------------------------------------------------------------------
    // Row factory
    // -------------------------------------------------------------------------
    function makeRow(filename) {
        var row = document.createElement('div');
        row.className = 'flac-row';
        row.innerHTML = [
            '<div class="flac-row-top">',
            '  <span class="flac-row-icon">-</span>',
            '  <span class="flac-row-name" title="' + filename + '">' + filename + '</span>',
            '  <span class="flac-row-pct"></span>',
            '  <span class="flac-row-status s-queued">queued</span>',
            '</div>',
            '<div class="flac-row-bar-wrap"><div class="flac-row-bar"></div></div>',
            '<div class="flac-row-meta">',
            '  <span class="flac-row-speed"></span>',
            '  <span class="flac-row-eta"></span>',
            '</div>'
        ].join('');
        logDiv.appendChild(row);

        var icon    = row.querySelector('.flac-row-icon');
        var status  = row.querySelector('.flac-row-status');
        var pctEl   = row.querySelector('.flac-row-pct');
        var bar     = row.querySelector('.flac-row-bar');
        var speedEl = row.querySelector('.flac-row-speed');
        var etaEl   = row.querySelector('.flac-row-eta');

        function clearMeta() {
            pctEl.textContent   = '';
            speedEl.textContent = '';
            etaEl.textContent   = '';
        }

        return {
            setActive: function () {
                icon.textContent = '>';
                status.textContent = 'dl...';
                status.className = 'flac-row-status s-active';
                bar.className = 'flac-row-bar';
                bar.style.width = '0%';
                row.scrollIntoView({ block: 'nearest' });
            },
            setProgress: function (pct, speed, eta) {
                bar.style.width = pct + '%';
                pctEl.textContent   = pct + '%';
                if (speed !== null && speed !== undefined) speedEl.textContent = speed;
                if (eta !== null && eta !== undefined) etaEl.textContent = eta;
            },
            setSaving: function () {
                icon.textContent = '>';
                status.textContent = 'saving...';
                status.className = 'flac-row-status s-active';
                bar.style.width = '100%';
                clearMeta();
            },
            setDone: function () {
                icon.textContent = '+';
                status.textContent = 'saved';
                status.className = 'flac-row-status s-done';
                bar.classList.add('done');
                bar.style.width = '100%';
                clearMeta();
            },
            setError: function (m) {
                icon.textContent = '!';
                status.textContent = m || 'error';
                status.className = 'flac-row-status s-error';
                bar.classList.add('error');
                bar.style.width = '100%';
                clearMeta();
            },
            setSkipped: function () {
                icon.textContent = '/';
                status.textContent = 'skipped';
                status.className = 'flac-row-status s-skipped';
                bar.style.width = '0%';
                clearMeta();
            },
            setCancelled: function () {
                icon.textContent = 'x';
                status.textContent = 'cancelled';
                status.className = 'flac-row-status s-cancel';
                bar.classList.add('error');
                clearMeta();
            }
        };
    }

    // -------------------------------------------------------------------------
    // Download one file
    // Phase 1: fetch + ReadableStream for real byte-level progress
    // Phase 2: GM_download(blobUrl) to save into the subfolder path
    // -------------------------------------------------------------------------
    function downloadOne(url, saveAs, rowCtrl, onBytes) {
        if (cancelRequested) {
            rowCtrl.setCancelled();
            return Promise.resolve('cancelled');
        }

        rowCtrl.setActive();

        var controller = new AbortController();
        activeHandles.push(controller);

        return fetch(url, { signal: controller.signal })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);

                var contentLength = parseInt(response.headers.get('content-length') || '0', 10);
                var reader     = response.body.getReader();
                var chunks     = [];
                var received   = 0;
                var startTime  = Date.now();
                var lastTime   = startTime;
                var lastBytes  = 0;
                var smoothRate = 0;
                var EMA        = 0.25;

                function pump() {
                    return reader.read().then(function (result) {

                        if (cancelRequested) {
                            reader.cancel();
                            if (onBytes) onBytes(0, true);
                            rowCtrl.setCancelled();
                            return 'cancelled';
                        }

                        if (result.done) {
                            if (onBytes) onBytes(0, true);
                            var blob    = new Blob(chunks);
                            var blobUrl = URL.createObjectURL(blob);
                            chunks = [];
                            rowCtrl.setSaving();
                            return new Promise(function (resolve) {
                                GM_download({
                                    url: blobUrl,
                                    name: saveAs,
                                    onload: function () {
                                        URL.revokeObjectURL(blobUrl);
                                        rowCtrl.setDone();
                                        resolve('done');
                                    },
                                    onerror: function (err) {
                                        URL.revokeObjectURL(blobUrl);
                                        rowCtrl.setError(err && err.error ? err.error : 'save error');
                                        resolve('error');
                                    }
                                });
                            });
                        }

                        chunks.push(result.value);
                        received += result.value.length;
                        if (onBytes) onBytes(result.value.length, false);

                        var now     = Date.now();
                        var elapsed = now - lastTime;
                        if (elapsed >= 300) {
                            var chunkRate = (received - lastBytes) / elapsed;
                            smoothRate    = smoothRate === 0
                                ? chunkRate
                                : EMA * chunkRate + (1 - EMA) * smoothRate;
                            lastTime  = now;
                            lastBytes = received;
                            var bps    = smoothRate * 1000;
                            var etaSec = (contentLength > 0 && bps > 0)
                                ? (contentLength - received) / bps
                                : NaN;
                            var pct = contentLength > 0
                                ? Math.round((received / contentLength) * 100)
                                : 0;
                            rowCtrl.setProgress(
                                pct,
                                fmtSpeed(bps),
                                contentLength > 0 ? fmtEta(etaSec) : ''
                            );
                        } else if (contentLength > 0) {
                            var pct2 = Math.round((received / contentLength) * 100);
                            rowCtrl.setProgress(pct2, null, null);
                        }

                        return pump();
                    });
                }

                return pump();
            })
            .catch(function (err) {
                if (cancelRequested || (err && err.name === 'AbortError')) {
                    rowCtrl.setCancelled();
                    return 'cancelled';
                }
                rowCtrl.setError(err && err.message ? err.message : 'fetch error');
                return 'error';
            });
    }

    // -------------------------------------------------------------------------
    // Concurrent pool runner
    // -------------------------------------------------------------------------
    async function runDownloads(files) {
        isRunning       = true;
        cancelRequested = false;
        failedFiles     = [];
        activeHandles   = [];

        startBtn.style.display   = 'none';
        cancelBtn.style.display  = 'block';
        cancelBtn.disabled       = false;
        retryBtn.style.display   = 'none';
        overallDiv.style.display = 'block';
        logDiv.style.display     = 'block';
        overallBar.classList.remove('cancelled');
        overallRate.textContent  = '';

        var folder = buildSavePath(rootInput.value, albumInput.value);
        var total     = files.length;
        var completed = 0;
        var saved     = 0;

        // Aggregate rate tracking
        var aggBytes      = 0;
        var aggLastUpdate = Date.now();
        var aggSmooth     = 0;
        var AGG_WIN       = 1500;
        var AGG_EMA       = 0.3;

        function onBytes(n, done) {
            if (done) return;
            aggBytes += n;
            var now     = Date.now();
            var elapsed = now - aggLastUpdate;
            if (elapsed >= AGG_WIN) {
                var rate  = aggBytes / elapsed;
                aggSmooth = aggSmooth === 0
                    ? rate
                    : AGG_EMA * rate + (1 - AGG_EMA) * aggSmooth;
                aggBytes      = 0;
                aggLastUpdate = now;
                overallRate.textContent = 'aggregate: ' + fmtSpeed(aggSmooth * 1000) + ' across ' + concurrency + ' streams';
            }
        }

        function updateOverall() {
            overallLabel.textContent = completed + ' / ' + total;
            var pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            overallPct.textContent = pct + '%';
            overallBar.style.width = pct + '%';
        }
        updateOverall();

        var queue   = files.slice();
        var pending = 0;

        await new Promise(function (resolveAll) {
            function fill() {
                while (queue.length > 0 && pending < concurrency && !cancelRequested) {
                    (function (f) {
                        pending++;
                        var saveAs = folder + '\\' + f.filename;
                        downloadOne(f.url, saveAs, f.rowCtrl, onBytes).then(function (result) {
                            pending--;
                            completed++;
                            if (result === 'done') {
                                saved++;
                            } else if (result === 'error') {
                                failedFiles.push({ url: f.url, filename: f.filename });
                            }
                            updateOverall();
                            if (pending === 0 && (queue.length === 0 || cancelRequested)) {
                                resolveAll();
                            } else {
                                fill();
                            }
                        });
                    }(queue.shift()));
                }

                if (cancelRequested && queue.length > 0) {
                    var remaining = queue.splice(0);
                    remaining.forEach(function (f) {
                        f.rowCtrl.setSkipped();
                        completed++;
                    });
                    updateOverall();
                    if (pending === 0) resolveAll();
                }

                if (pending === 0 && queue.length === 0) resolveAll();
            }
            fill();
        });

        activeHandles = [];
        isRunning     = false;
        overallRate.textContent = '';

        if (cancelRequested) {
            overallLabel.textContent = 'Cancelled -- ' + saved + '/' + total + ' saved';
            overallBar.classList.add('cancelled');
            overallBar.style.width = '100%';
            overallPct.textContent = '';
        } else {
            overallLabel.textContent = 'Done: ' + saved + '/' + total + ' saved' +
                (failedFiles.length > 0 ? ' (' + failedFiles.length + ' failed)' : '');
            overallPct.textContent = '100%';
            overallBar.style.width = '100%';
        }

        startBtn.style.display  = 'block';
        cancelBtn.style.display = 'none';
        retryBtn.style.display  = failedFiles.length > 0 ? 'block' : 'none';
        refreshBtn();
    }

    // -------------------------------------------------------------------------
    // Button handlers
    // -------------------------------------------------------------------------
    startBtn.addEventListener('click', function () {
        var links = getFlacLinks();
        if (links.length === 0) { alert('No FLAC files found on this page.'); return; }
        if (!rootInput.value.trim() && !albumInput.value.trim()) { rootInput.focus(); return; }

        logDiv.innerHTML = '';
        overallBar.style.width = '0%';
        overallPct.textContent = '0%';

        var files = links.map(function (f) {
            return { url: f.url, filename: f.filename, rowCtrl: makeRow(f.filename) };
        });
        runDownloads(files);
    });

    cancelBtn.addEventListener('click', function () {
        cancelRequested = true;
        cancelBtn.disabled = true;
        activeHandles.forEach(function (h) {
            if (h && typeof h.abort === 'function') h.abort();
        });
        activeHandles = [];
    });

    retryBtn.addEventListener('click', function () {
        if (failedFiles.length === 0) return;
        var toRetry = failedFiles.slice();
        failedFiles = [];
        retryBtn.style.display = 'none';
        var files = toRetry.map(function (f) {
            return { url: f.url, filename: f.filename, rowCtrl: makeRow(f.filename) };
        });
        runDownloads(files);
    });

    // -------------------------------------------------------------------------
    // Init -- runs immediately, no load event dependency
    // -------------------------------------------------------------------------
    rootInput.value  = GM_getValue('rootPrefix', 'FLACDL');
    albumInput.value = albumFromURL();
    updatePreview();
    setConcurrency(concurrency);
    refreshBtn();

})();
