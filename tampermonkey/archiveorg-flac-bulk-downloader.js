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
    // Collect FLAC links from the page
    // -------------------------------------------------------------------------
    function getFlacLinks() {
        var anchors = document.querySelectorAll('a[href]');
        var results = [];
        for (var i = 0; i < anchors.length; i++) {
            var href = anchors[i].href;
            if (href.toLowerCase().endsWith('.flac')) {
                var filename = decodeURIComponent(href.split('/').pop());
                results.push({ url: href, filename: filename });
            }
        }
        var seen = {};
        return results.filter(function (f) {
            if (seen[f.url]) return false;
            seen[f.url] = true;
            return true;
        });
    }

    // Guess a sensible default subfolder name from the URL path
    // e.g. ".../Tame Impala - Currents (2015) [FLAC]/" -> "Tame Impala - Currents (2015) [FLAC]"
    function guessFolder() {
        var parts = decodeURIComponent(window.location.pathname).replace(/\/$/, '').split('/');
        return parts[parts.length - 1] || 'archive-flac';
    }

    // -------------------------------------------------------------------------
    // Inject styles
    // -------------------------------------------------------------------------
    var style = document.createElement('style');
    style.textContent = [
        '#flac-dl-btn {',
        '  position: fixed;',
        '  bottom: 24px;',
        '  right: 24px;',
        '  z-index: 99999;',
        '  background: #1a1a1a;',
        '  color: #e8e8e8;',
        '  border: 1.5px solid #444;',
        '  border-radius: 6px;',
        '  padding: 10px 18px;',
        '  font: 600 13px/1 "Courier New", monospace;',
        '  letter-spacing: 0.04em;',
        '  cursor: pointer;',
        '  box-shadow: 0 4px 18px rgba(0,0,0,0.45);',
        '  transition: background 0.15s, border-color 0.15s;',
        '  user-select: none;',
        '}',
        '#flac-dl-btn:hover { background: #2e2e2e; border-color: #888; color: #fff; }',
        '#flac-dl-btn:disabled { opacity: 0.45; cursor: not-allowed; }',

        '#flac-dl-panel {',
        '  position: fixed;',
        '  bottom: 72px;',
        '  right: 24px;',
        '  z-index: 99999;',
        '  width: 400px;',
        '  background: #111;',
        '  border: 1.5px solid #333;',
        '  border-radius: 8px;',
        '  font: 12px/1.5 "Courier New", monospace;',
        '  color: #ccc;',
        '  box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
        '  overflow: hidden;',
        '  display: none;',
        '}',

        '#flac-dl-panel-header {',
        '  display: flex;',
        '  align-items: center;',
        '  justify-content: space-between;',
        '  padding: 10px 14px;',
        '  background: #1c1c1c;',
        '  border-bottom: 1px solid #2a2a2a;',
        '}',
        '#flac-dl-panel-header span { font-weight: 700; color: #fff; font-size: 12px; }',
        '#flac-dl-panel-close {',
        '  background: none; border: none; color: #777;',
        '  font-size: 16px; cursor: pointer; line-height: 1; padding: 0;',
        '}',
        '#flac-dl-panel-close:hover { color: #fff; }',

        '#flac-dl-folder-row {',
        '  display: flex; align-items: center; gap: 8px;',
        '  padding: 9px 14px;',
        '  border-bottom: 1px solid #1e1e1e;',
        '  background: #161616;',
        '}',
        '#flac-dl-folder-label { color: #666; font-size: 10px; flex-shrink: 0; }',
        '#flac-dl-folder-input {',
        '  flex: 1; background: #222; border: 1px solid #333;',
        '  border-radius: 3px; color: #ddd; font: 11px/1 "Courier New", monospace;',
        '  padding: 4px 7px; outline: none;',
        '}',
        '#flac-dl-folder-input:focus { border-color: #555; }',
        '#flac-dl-folder-note { color: #444; font-size: 10px; padding: 4px 14px 6px; }',

        '#flac-dl-start-row {',
        '  padding: 8px 14px;',
        '  border-bottom: 1px solid #1e1e1e;',
        '}',
        '#flac-dl-start-btn {',
        '  width: 100%; background: #1e3d2a; border: 1px solid #2e6644;',
        '  color: #52c98a; border-radius: 4px;',
        '  font: 700 11px/1 "Courier New", monospace;',
        '  letter-spacing: 0.06em; padding: 7px 0; cursor: pointer;',
        '  transition: background 0.15s;',
        '}',
        '#flac-dl-start-btn:hover { background: #254d35; }',
        '#flac-dl-start-btn:disabled { opacity: 0.4; cursor: not-allowed; }',

        '#flac-dl-overall {',
        '  padding: 8px 14px 6px;',
        '  border-bottom: 1px solid #1e1e1e;',
        '  display: none;',
        '}',
        '#flac-dl-overall-bar-wrap {',
        '  background: #222; border-radius: 3px; height: 6px;',
        '  margin-top: 6px; overflow: hidden;',
        '}',
        '#flac-dl-overall-bar {',
        '  height: 100%; width: 0%;',
        '  background: linear-gradient(90deg, #3a8f5f, #52c98a);',
        '  border-radius: 3px;',
        '  transition: width 0.3s;',
        '}',

        '#flac-dl-log {',
        '  max-height: 200px;',
        '  overflow-y: auto;',
        '  padding: 6px 14px;',
        '  display: none;',
        '}',
        '.flac-dl-row {',
        '  display: flex;',
        '  align-items: center;',
        '  gap: 8px;',
        '  padding: 4px 0;',
        '  border-bottom: 1px solid #1a1a1a;',
        '}',
        '.flac-dl-row:last-child { border-bottom: none; }',
        '.flac-dl-icon { flex-shrink: 0; font-size: 12px; width: 14px; text-align: center; color: #555; }',
        '.flac-dl-name {',
        '  flex: 1; overflow: hidden;',
        '  text-overflow: ellipsis; white-space: nowrap;',
        '  color: #888; font-size: 11px;',
        '}',
        '.flac-dl-status { flex-shrink: 0; font-size: 10px; color: #444; min-width: 62px; text-align: right; }',
        '.flac-dl-status.queued { color: #444; }',
        '.flac-dl-status.active { color: #e0b030; }',
        '.flac-dl-status.done   { color: #52c98a; }',
        '.flac-dl-status.err    { color: #e05555; }',

        '#flac-dl-footer {',
        '  padding: 6px 14px;',
        '  border-top: 1px solid #1e1e1e;',
        '  color: #3a3a3a; font-size: 10px; text-align: center;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    // -------------------------------------------------------------------------
    // Build UI
    // -------------------------------------------------------------------------
    var btn = document.createElement('button');
    btn.id = 'flac-dl-btn';
    btn.textContent = 'DOWNLOAD FLACS';

    var panel = document.createElement('div');
    panel.id = 'flac-dl-panel';
    panel.innerHTML = [
        '<div id="flac-dl-panel-header">',
        '  <span>FLAC DOWNLOADER</span>',
        '  <button id="flac-dl-panel-close" title="Close">x</button>',
        '</div>',
        '<div id="flac-dl-folder-row">',
        '  <span id="flac-dl-folder-label">SUBFOLDER</span>',
        '  <input id="flac-dl-folder-input" type="text" spellcheck="false" placeholder="subfolder name inside Downloads" />',
        '</div>',
        '<div id="flac-dl-folder-note">',
        '  Files save to Downloads/[subfolder]. Edit the path above if needed.',
        '  To change the root Downloads location use Firefox settings.',
        '</div>',
        '<div id="flac-dl-start-row">',
        '  <button id="flac-dl-start-btn">START DOWNLOAD</button>',
        '</div>',
        '<div id="flac-dl-overall">',
        '  <span id="flac-dl-overall-label"></span>',
        '  <div id="flac-dl-overall-bar-wrap">',
        '    <div id="flac-dl-overall-bar"></div>',
        '  </div>',
        '</div>',
        '<div id="flac-dl-log"></div>',
        '<div id="flac-dl-footer">powered by GM_download -- requires Tampermonkey</div>'
    ].join('');

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var folderInput  = document.getElementById('flac-dl-folder-input');
    var startBtn     = document.getElementById('flac-dl-start-btn');
    var overallDiv   = document.getElementById('flac-dl-overall');
    var overallLabel = document.getElementById('flac-dl-overall-label');
    var overallBar   = document.getElementById('flac-dl-overall-bar');
    var logDiv       = document.getElementById('flac-dl-log');

    // Restore last-used folder from storage, otherwise guess from URL
    folderInput.value = GM_getValue('lastFolder', guessFolder());

    document.getElementById('flac-dl-panel-close').addEventListener('click', function () {
        panel.style.display = 'none';
    });

    btn.addEventListener('click', function () {
        // Re-populate guess if field was left blank
        if (!folderInput.value.trim()) folderInput.value = guessFolder();
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    // -------------------------------------------------------------------------
    // Row helpers
    // -------------------------------------------------------------------------
    function addRow(filename) {
        var row = document.createElement('div');
        row.className = 'flac-dl-row';
        row.innerHTML = [
            '<span class="flac-dl-icon">-</span>',
            '<span class="flac-dl-name" title="' + filename + '">' + filename + '</span>',
            '<span class="flac-dl-status queued">queued</span>'
        ].join('');
        logDiv.appendChild(row);
        var icon   = row.querySelector('.flac-dl-icon');
        var status = row.querySelector('.flac-dl-status');
        return {
            setActive: function () {
                icon.textContent = '>';
                status.textContent = 'downloading';
                status.className = 'flac-dl-status active';
                row.scrollIntoView({ block: 'nearest' });
            },
            setDone: function () {
                icon.textContent = '+';
                status.textContent = 'saved';
                status.className = 'flac-dl-status done';
            },
            setError: function (msg) {
                icon.textContent = '!';
                status.textContent = msg || 'error';
                status.className = 'flac-dl-status err';
            }
        };
    }

    // -------------------------------------------------------------------------
    // Download one file via GM_download - returns a Promise
    // -------------------------------------------------------------------------
    function downloadOne(url, saveAs, rowCtrl) {
        return new Promise(function (resolve) {
            rowCtrl.setActive();
            GM_download({
                url: url,
                name: saveAs,
                onload: function () {
                    rowCtrl.setDone();
                    resolve({ ok: true });
                },
                onerror: function (err) {
                    rowCtrl.setError(err && err.error ? err.error : 'error');
                    resolve({ ok: false });
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // Start button handler
    // -------------------------------------------------------------------------
    startBtn.addEventListener('click', async function () {
        var files = getFlacLinks();
        if (files.length === 0) {
            alert('No FLAC files found on this page.');
            return;
        }

        var folder = folderInput.value.trim();
        if (!folder) {
            folderInput.focus();
            return;
        }
        GM_setValue('lastFolder', folder);

        logDiv.innerHTML = '';
        overallDiv.style.display = 'block';
        logDiv.style.display = 'block';
        overallBar.style.width = '0%';
        startBtn.disabled = true;
        btn.disabled = true;

        var rows = files.map(function (f) { return addRow(f.filename); });

        var completed = 0;
        var failed = 0;

        for (var i = 0; i < files.length; i++) {
            overallLabel.textContent = (i + 1) + ' / ' + files.length + '  ' + files[i].filename;

            // GM_download interprets slashes as subdirectory paths inside Downloads
            var saveAs = folder + '/' + files[i].filename;
            var result = await downloadOne(files[i].url, saveAs, rows[i]);
            if (!result.ok) failed++;
            completed++;
            overallBar.style.width = Math.round((completed / files.length) * 100) + '%';
        }

        var ok = completed - failed;
        overallLabel.textContent =
            'Done: ' + ok + '/' + files.length + ' saved to Downloads/' + folder +
            (failed > 0 ? ' (' + failed + ' failed)' : '');

        startBtn.disabled = false;
        btn.disabled = false;
    });

    // -------------------------------------------------------------------------
    // Hide button entirely if no FLACs are on this page
    // -------------------------------------------------------------------------
    window.addEventListener('load', function () {
        var files = getFlacLinks();
        if (files.length === 0) {
            btn.style.display = 'none';
        } else {
            btn.textContent = 'DOWNLOAD ' + files.length + ' FLAC' + (files.length !== 1 ? 'S' : '');
        }
    });

})();
