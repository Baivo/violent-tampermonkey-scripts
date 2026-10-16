// ==UserScript==
// @name         Archive.org FLAC Bulk Downloader
// @namespace    https://github.com/Baivo/violent-tampermonkey-scripts
// @version      2.1
// @description  One-click bulk download of all FLAC files from any archive.org download page, into a folder you pick
// @author       Baivo
// @match        https://archive.org/download/*
// @connect      archive.org
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // Opened a .flac directly: nothing to list.
    if (/\.flac$/i.test(location.pathname)) return;

    const MAX_ATTEMPTS    = 3;
    const RETRY_DELAYS_MS = [3000, 10000];
    // GM_download errors no retry can fix; the run halts on the first one.
    const CONFIG_ERRORS = {
        not_enabled:     'downloads are disabled in Tampermonkey settings',
        not_whitelisted: '.flac is not in Tampermonkey\'s download extension whitelist',
        not_permitted:   'Tampermonkey lacks the browser "downloads" permission',
        not_supported:   'GM_download is not supported in this browser/manager'
    };

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function safeDecode(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }

    // Windows-safe path segment; Chrome rejects the download outright otherwise.
    function sanitizeSegment(s) {
        s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
        if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
        return s;
    }

    // Accepts / or \ separators, always emits / (the only separator the downloads API takes).
    function sanitizePath(p) {
        return (p || '').split(/[\\/]+/).map(sanitizeSegment)
            .filter(function (s) { return s && s !== '.' && s !== '..'; })
            .join('/');
    }

    function fmtBytes(b) {
        if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
        if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024)       return (b / 1024).toFixed(0) + ' KB';
        return b + ' B';
    }

    function fmtSpeed(bps) { return fmtBytes(Math.round(bps)) + '/s'; }

    function fmtEta(secs) {
        if (!isFinite(secs) || secs < 0) return '';
        secs = Math.round(secs);
        if (secs < 60)   return secs + 's';
        if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
        return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
    }

    // Smoothed bytes/sec from a monotonically growing byte count.
    function makeMeter() {
        var t0 = performance.now(), b0 = 0, rate = 0;
        return function (bytes) {
            var now = performance.now(), dt = now - t0;
            if (dt >= 500) {
                var r = (bytes - b0) * 1000 / dt;
                rate = rate ? 0.3 * r + 0.7 * rate : r;
                t0 = now; b0 = bytes;
            }
            return rate;
        };
    }

    // Page window: the folder picker and IndexedDB must be called on the real
    // window, not the userscript sandbox wrapper.
    var W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var hasFS = typeof W.showDirectoryPicker === 'function';

    // Tiny IndexedDB key/value store; directory handles can't go in GM_setValue.
    function idb(mode, fn) {
        return new Promise(function (resolve, reject) {
            var open = W.indexedDB.open('flac-dl', 1);
            open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
            open.onerror = function () { reject(open.error); };
            open.onsuccess = function () {
                var tx = open.result.transaction('kv', mode);
                var req = fn(tx.objectStore('kv'));
                tx.oncomplete = function () { open.result.close(); resolve(req.result); };
                tx.onerror = function () { open.result.close(); reject(tx.error); };
            };
        });
    }
    function idbGet(k)    { return idb('readonly',  function (s) { return s.get(k); }); }
    function idbSet(k, v) { return idb('readwrite', function (s) { return s.put(v, k); }); }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    // -------------------------------------------------------------------------
    // Discover files. Paths are kept relative to the item root so CD1/01.flac
    // and CD2/01.flac don't collide, and links outside this item are ignored.
    // -------------------------------------------------------------------------
    var pathParts  = location.pathname.split('/');          // ['', 'download', item, ...]
    var itemPrefix = '/download/' + pathParts[2] + '/';
    var itemId     = safeDecode(pathParts[2] || '');

    function findFlacFiles() {
        var seen = new Set(), files = [];
        document.querySelectorAll('a[href]').forEach(function (a) {
            var u;
            try { u = new URL(a.href); } catch (e) { return; }
            if (u.host !== location.host) return;
            if (!u.pathname.startsWith(itemPrefix) || !/\.flac$/i.test(u.pathname)) return;
            var url = u.origin + u.pathname;
            if (seen.has(url)) return;
            seen.add(url);
            var rel = u.pathname.slice(itemPrefix.length).split('/').map(safeDecode).join('/');
            files.push({ url: url, relPath: rel });
        });
        return files;
    }

    var jobs = findFlacFiles().map(function (f) {
        return { url: f.url, relPath: f.relPath, savePath: sanitizePath(f.relPath), row: null, loaded: 0, total: 0 };
    });
    if (jobs.length === 0) return;

    var concurrency = Math.min(5, Math.max(1, parseInt(GM_getValue('concurrency', 3), 10) || 3));
    var run = null;          // the active or most recent run
    var unfinished = [];     // jobs from the last run that didn't save

    // -------------------------------------------------------------------------
    // UI (shadow DOM so archive.org's CSS can't restyle it)
    // -------------------------------------------------------------------------
    var host = document.createElement('div');
    var root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);

    var style = document.createElement('style');
    style.textContent = `
:host { all: initial; --mono: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font-family: var(--mono); }

.fab {
  position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
  background: #161616; color: #e0e0e0; border: 1.5px solid #404040; border-radius: 6px;
  padding: 10px 16px; font: 700 12px/1 var(--mono); letter-spacing: .05em;
  cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,.5); user-select: none;
}
.fab:hover { background: #252525; border-color: #777; color: #fff; }
.fab.running { border-color: #2e5c42; color: #4ec97e; }

.panel {
  position: fixed; bottom: 72px; right: 24px; z-index: 2147483647;
  width: min(480px, calc(100vw - 32px)); max-height: calc(100vh - 100px);
  display: flex; flex-direction: column;
  background: #0f0f0f; border: 1.5px solid #333; border-radius: 8px;
  font: 12px/1.45 var(--mono); color: #c8c8c8;
  box-shadow: 0 10px 40px rgba(0,0,0,.7); overflow: hidden;
}
.panel > * { flex-shrink: 0; }

.header { display: flex; align-items: center; gap: 10px; padding: 9px 14px; background: #181818; border-bottom: 1px solid #303030; }
.title { font-weight: 700; color: #fff; letter-spacing: .08em; }
.count { flex: 1; color: #8a8a8a; font-size: 11px; }
.close { background: none; border: none; color: #999; font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px; }
.close:hover { color: #fff; }

.paths { padding: 10px 14px; border-bottom: 1px solid #242424; background: #141414; }
.field { display: block; margin-bottom: 8px; }
.label { display: block; font-size: 11px; color: #aaa; letter-spacing: .08em; margin-bottom: 4px; }
.label em { font-style: normal; color: #707070; margin-left: 6px; letter-spacing: 0; }
.pick-row { display: flex; gap: 6px; align-items: stretch; }
.dir-name {
  flex: 1; min-width: 0; padding: 6px 8px; background: #222; border: 1px solid #3a3a3a; border-radius: 3px;
  color: #e8e8e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dir-name.none { color: #d8c65a; }
.pick {
  flex-shrink: 0; padding: 0 12px; border-radius: 3px; cursor: pointer; font: 700 11px/1 var(--mono);
  background: #1c1c1c; border: 1px solid #454545; color: #ccc;
}
.pick:hover:not(:disabled) { background: #282828; color: #fff; }
.pick:disabled { opacity: .5; cursor: not-allowed; }
input {
  width: 100%; background: #222; border: 1px solid #3a3a3a; border-radius: 3px;
  color: #e8e8e8; font: 12px/1.2 var(--mono); padding: 6px 8px; outline: none;
}
input:focus { border-color: #666; background: #272727; }
input:disabled { opacity: .5; }
.preview {
  padding: 5px 7px; background: #0b0b0b; border: 1px solid #2a2a2a; border-radius: 3px;
  font-size: 11px; color: #808080; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.preview b { color: #d0d0d0; font-weight: normal; }

.conc { display: flex; align-items: center; gap: 6px; padding: 7px 14px; border-bottom: 1px solid #1e1e1e; background: #111; }
.conc .label { margin: 0 6px 0 0; }
.conc button {
  width: 30px; height: 24px; border-radius: 3px; cursor: pointer; font: 700 11px/1 var(--mono);
  border: 1px solid #353535; background: #1c1c1c; color: #999;
}
.conc button:hover { background: #252525; color: #ddd; border-color: #555; }
.conc button.on { background: #1e3528; border-color: #2e5c42; color: #4ec97e; }

.actions { display: flex; gap: 6px; padding: 8px 14px; border-bottom: 1px solid #1a1a1a; }
.act { flex: 1; border-radius: 3px; cursor: pointer; font: 700 11px/1 var(--mono); letter-spacing: .06em; padding: 8px 0; border: 1px solid; }
.act:disabled { opacity: .35; cursor: not-allowed; }
.start  { background: #1a3528; border-color: #2a5c42; color: #4ec97e; }
.start:not(:disabled):hover  { background: #214432; }
.cancel { background: #351a1a; border-color: #5c2a2a; color: #e06060; }
.cancel:not(:disabled):hover { background: #441f1f; }
.retry  { background: #2a2818; border-color: #4e4820; color: #d8c65a; }
.retry:not(:disabled):hover  { background: #343020; }

.overall { padding: 8px 14px 7px; border-bottom: 1px solid #1a1a1a; }
.o-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 5px; }
.o-label { color: #ddd; }
.o-label.bad { color: #e06060; }
.o-pct { color: #999; }
.o-wrap { background: #1c1c1c; border-radius: 2px; height: 6px; overflow: hidden; }
.o-bar { height: 100%; width: 0; background: linear-gradient(90deg, #2a6644, #4ec97e); transition: width .3s ease; }
.o-bar.bad { background: linear-gradient(90deg, #6a2a2a, #c94e4e); }
.o-rate { font-size: 11px; color: #888; margin-top: 4px; min-height: 1.45em; }

.log { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 0; }
.row { padding: 5px 14px 6px; border-bottom: 1px solid #181818; }
.row:last-child { border-bottom: none; }
.row-top { display: flex; align-items: center; gap: 8px; }
.icon { flex-shrink: 0; width: 12px; text-align: center; color: #777; }
.name { flex: 1; min-width: 0; color: #c0c0c0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { flex-shrink: 0; font-size: 11px; min-width: 64px; text-align: right; color: #777; }
.row[data-state=active] .status, .row[data-state=wait] .status { color: #d8c65a; }
.row[data-state=done]   .status, .row[data-state=done] .icon   { color: #4ec97e; }
.row[data-state=error]  .status, .row[data-state=error] .icon  { color: #e06060; }
.row[data-state=cancelled] .status { color: #b05050; }
.bar-wrap { height: 3px; background: #1c1c1c; border-radius: 1px; margin-top: 4px; overflow: hidden; }
.bar { height: 100%; width: 0; background: #d8c65a; transition: width .15s; }
.bar.ok  { background: #4ec97e; transition: none; }
.bar.err { background: #c94e4e; transition: none; }
.bar.indet { width: 30%; animation: slide 1.1s linear infinite; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.meta { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: #8a8a8a; margin-top: 2px; }
.meta:empty, .meta span:empty { display: none; }
.row[data-state=error] .meta, .row[data-state=wait] .meta { color: #c07070; }

.footer { padding: 5px 14px; border-top: 1px solid #1a1a1a; font-size: 11px; text-align: right; }
.footer a { color: #6a6a6a; text-decoration: none; }
.footer a:hover { color: #aaa; }
`;
    root.appendChild(style);

    var fab = el('button', 'fab');
    root.appendChild(fab);

    var panel = el('div', 'panel');
    panel.hidden = true;
    panel.innerHTML = `
<div class="header">
  <span class="title">[ FLAC DOWNLOADER ]</span><span class="count"></span>
  <button class="close" title="Close (Esc)">&times;</button>
</div>
<div class="paths">
  <div class="field fs-only"><span class="label">SAVE TO <em>remembered</em></span>
    <div class="pick-row"><span class="dir-name"></span><button class="pick">CHOOSE…</button></div></div>
  <label class="field gm-only"><span class="label">ROOT FOLDER <em>inside Downloads; needs Tampermonkey "Browser API" download mode</em></span>
    <input class="root-in" type="text" spellcheck="false" placeholder="e.g. Music/Archive.org"></label>
  <label class="field"><span class="label">ALBUM FOLDER <em>defaults to the item id</em></span>
    <input class="album-in" type="text" spellcheck="false"></label>
  <div class="preview"></div>
</div>
<div class="conc"><span class="label">PARALLEL</span></div>
<div class="actions">
  <button class="act start">START</button>
  <button class="act cancel" hidden>CANCEL</button>
  <button class="act retry" hidden>RETRY</button>
</div>
<div class="overall" hidden>
  <div class="o-top"><span class="o-label"></span><span class="o-pct"></span></div>
  <div class="o-wrap"><div class="o-bar"></div></div>
  <div class="o-rate"></div>
</div>
<div class="log"></div>
<div class="footer"><a href="https://github.com/Baivo/violent-tampermonkey-scripts" target="_blank" rel="noopener">github.com/Baivo/violent-tampermonkey-scripts</a></div>`;
    root.appendChild(panel);

    function $(sel) { return panel.querySelector(sel); }
    var rootIn    = $('.root-in');
    var albumIn   = $('.album-in');
    var preview   = $('.preview');
    var concRow   = $('.conc');
    var startBtn  = $('.start');
    var cancelBtn = $('.cancel');
    var retryBtn  = $('.retry');
    var overall   = $('.overall');
    var oLabel    = $('.o-label');
    var oPct      = $('.o-pct');
    var oBar      = $('.o-bar');
    var oRate     = $('.o-rate');
    var logEl     = $('.log');

    $('.count').textContent = jobs.length + ' file' + (jobs.length === 1 ? '' : 's');

    // -------------------------------------------------------------------------
    // Folder fields
    // -------------------------------------------------------------------------
    var dirName = $('.dir-name');
    var pickBtn = $('.pick');
    var dirHandle = null;   // FS mode: the folder the user picked

    panel.querySelectorAll(hasFS ? '.gm-only' : '.fs-only').forEach(function (e) { e.hidden = true; });

    rootIn.value  = GM_getValue('rootPrefix', 'FLACDL');
    albumIn.value = itemId;

    // FS mode: album folder inside the picked folder. GM mode: root/album inside Downloads.
    function saveFolder() {
        return hasFS
            ? sanitizePath(albumIn.value)
            : sanitizePath(rootIn.value + '/' + albumIn.value) || 'FLAC';
    }

    function updatePreview() {
        var base = hasFS ? (dirHandle ? dirHandle.name : '?') : 'Downloads';
        var sub  = saveFolder();
        preview.textContent = base + '/';
        if (sub) { preview.appendChild(el('b', null, sub)); preview.appendChild(document.createTextNode('/')); }
        preview.appendChild(document.createTextNode('…'));
        preview.title = base + '/' + (sub ? sub + '/' : '');
        dirName.textContent = dirHandle ? dirHandle.name : 'no folder chosen';
        dirName.classList.toggle('none', !dirHandle);
    }

    async function chooseDir() {
        try {
            dirHandle = await W.showDirectoryPicker({ id: 'flac-dl', mode: 'readwrite' });
        } catch (e) {
            if (e && e.name === 'AbortError') return null;   // user closed the picker
            throw e;
        }
        try { await idbSet('dir', dirHandle); } catch (e) { /* not remembered; still usable now */ }
        updatePreview();
        return dirHandle;
    }

    // Needs a user gesture when the browser asks to re-confirm access.
    async function ensureDir() {
        if (!dirHandle && !(await chooseDir())) return null;
        var p = await dirHandle.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted') p = await dirHandle.requestPermission({ mode: 'readwrite' });
        return p === 'granted' ? dirHandle : null;
    }

    pickBtn.addEventListener('click', function () {
        chooseDir().catch(function (e) { alert('Could not open folder: ' + e.message); });
    });

    if (hasFS) {
        idbGet('dir').then(function (h) { if (h && !dirHandle) { dirHandle = h; updatePreview(); } })
            .catch(function () { /* nothing remembered */ });
    }

    rootIn.addEventListener('input', function () {
        GM_setValue('rootPrefix', rootIn.value);
        updatePreview();
    });
    albumIn.addEventListener('input', updatePreview);
    updatePreview();

    // -------------------------------------------------------------------------
    // Concurrency (applies live, including mid-run)
    // -------------------------------------------------------------------------
    var concBtns = [];
    for (var n = 1; n <= 5; n++) {
        var b = el('button', null, String(n));
        b.dataset.n = n;
        b.addEventListener('click', function (e) { setConcurrency(+e.currentTarget.dataset.n); });
        concRow.appendChild(b);
        concBtns.push(b);
    }
    function setConcurrency(n) {
        concurrency = n;
        GM_setValue('concurrency', n);
        concBtns.forEach(function (b) { b.classList.toggle('on', +b.dataset.n === n); });
        if (run && run.pump) run.pump();
    }
    setConcurrency(concurrency);

    // -------------------------------------------------------------------------
    // Panel open/close
    // -------------------------------------------------------------------------
    function setPanel(open) { panel.hidden = !open; }
    fab.addEventListener('click', function () { setPanel(panel.hidden); });
    $('.close').addEventListener('click', function () { setPanel(false); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !panel.hidden) setPanel(false);
    });

    window.addEventListener('beforeunload', function (e) {
        if (run && run.running) { e.preventDefault(); e.returnValue = ''; }
    });

    // -------------------------------------------------------------------------
    // Rows
    // -------------------------------------------------------------------------
    function makeRow(label) {
        var row    = el('div', 'row');
        var top    = el('div', 'row-top');
        var icon   = el('span', 'icon', '·');
        var name   = el('span', 'name', label);
        var status = el('span', 'status', 'ready');
        var wrap   = el('div', 'bar-wrap');
        var bar    = el('div', 'bar');
        var meta   = el('div', 'meta');
        var left   = el('span');
        var right  = el('span');
        name.title = label;
        top.append(icon, name, status);
        wrap.append(bar);
        meta.append(left, right);
        row.append(top, wrap, meta);
        row.dataset.state = 'ready';
        logEl.append(row);

        function set(state, ch, text, barCls, width) {
            row.dataset.state = state;
            icon.textContent = ch;
            status.textContent = text;
            bar.className = 'bar' + (barCls ? ' ' + barCls : '');
            bar.style.width = width == null ? '' : width;
            left.textContent = right.textContent = '';
        }

        // Follow the active row unless the user is hovering the list to read it.
        function reveal() {
            if (logEl.matches(':hover')) return;
            var top = row.offsetTop, bottom = top + row.offsetHeight;
            if (top < logEl.scrollTop || bottom > logEl.scrollTop + logEl.clientHeight) {
                logEl.scrollTop = top - logEl.clientHeight / 2;
            }
        }

        return {
            queued:    function () { set('queued', '·', 'queued', '', '0%'); },
            skipped:   function () { set('skipped', '/', 'not started', '', '0%'); },
            cancelled: function () { set('cancelled', 'x', 'cancelled', 'err', '100%'); },
            done:      function () { set('done', '+', 'saved', 'ok', '100%'); },
            existed:   function () { set('done', '=', 'already there', 'ok', '100%'); },
            active: function (attempt) {
                set('active', '>', attempt > 1 ? 'try ' + attempt + '/' + MAX_ATTEMPTS : 'starting', 'indet', null);
                reveal();
            },
            progress: function (loaded, total, rate) {
                if (row.dataset.state !== 'active') return;
                if (total > 0) {
                    var p = Math.min(100, loaded / total * 100);
                    bar.className = 'bar';
                    bar.style.width = p.toFixed(1) + '%';
                    status.textContent = Math.floor(p) + '%';
                    left.textContent = fmtBytes(loaded) + ' / ' + fmtBytes(total);
                    right.textContent = rate > 0 ? fmtSpeed(rate) + '  ' + fmtEta((total - loaded) / rate) : '';
                } else {
                    status.textContent = 'downloading';
                    left.textContent = loaded ? fmtBytes(loaded) : '';
                    right.textContent = rate > 0 ? fmtSpeed(rate) : '';
                }
            },
            waiting: function (err, ms) {
                set('wait', '~', 'retrying', 'err', '100%');
                left.textContent = err;
                right.textContent = 'next try in ' + Math.round(ms / 1000) + 's';
            },
            error: function (msg) {
                set('error', '!', 'failed', 'err', '100%');
                left.textContent = msg;
            }
        };
    }

    jobs.forEach(function (j) { j.row = makeRow(j.relPath); });

    // -------------------------------------------------------------------------
    // Download one file straight from archive.org via GM_download.
    // Nothing is buffered in the page, so album size doesn't matter.
    // -------------------------------------------------------------------------
    function gmDownload(url, name, onProgress) {
        var settle, handle, settled = false;
        var promise = new Promise(function (resolve) {
            settle = function (r) { if (!settled) { settled = true; resolve(r); } };
        });
        try {
            handle = GM_download({
                url: url,
                name: name,
                onprogress: onProgress,
                onload:    function () { settle({ ok: true }); },
                ontimeout: function () { settle({ ok: false, error: 'timed out' }); },
                onerror:   function (e) {
                    var d = e && e.details;
                    settle({ ok: false, error: (e && e.error) || 'error', details: typeof d === 'string' ? d : '' });
                }
            });
        } catch (e) {
            settle({ ok: false, error: e.message || 'GM_download threw' });
        }
        return {
            promise: promise,
            // Managers don't reliably fire onerror after abort(), so settle here.
            abort: function () {
                try { if (handle && handle.abort) handle.abort(); } catch (e) { /* already finished */ }
                settle({ ok: false, aborted: true });
            }
        };
    }

    function sleep(ms, r) {
        return new Promise(function (resolve) {
            var t = setTimeout(wake, ms);
            function wake() { clearTimeout(t); r.waiters.delete(wake); resolve(); }
            r.waiters.add(wake);
        });
    }

    // -------------------------------------------------------------------------
    // Savers: one attempt at one file. Each resolves to
    //   { ok: true [, existed: true] } | { ok: false, error, details } | { aborted: true }
    // and registers an { abort } token in r.active while running.
    // -------------------------------------------------------------------------

    // Streams the response straight to disk in the picked folder. The browser
    // writes to a temp file and only renames it into place on close(), so a
    // cancelled or failed transfer never leaves a truncated .flac behind.
    async function saveViaFS(job, r, baseDir, onProgress) {
        var ctl = new AbortController(), aborted = false, writable = null, created = false, dir, fname;
        var token = { abort: function () { aborted = true; ctl.abort(); } };
        r.active.add(token);
        try {
            var parts = job.savePath.split('/');
            fname = parts.pop();
            dir = baseDir;
            for (var i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });

            var res = await fetch(job.url, { signal: ctl.signal });
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            var total = parseInt(res.headers.get('content-length') || '0', 10);

            // Same name and same size already on disk: treat as saved, so START resumes.
            try {
                var existing = await (await dir.getFileHandle(fname)).getFile();
                if (total > 0 && existing.size === total) { ctl.abort(); return { ok: true, existed: true }; }
            } catch (e) { created = true; /* not there yet */ }

            writable = await (await dir.getFileHandle(fname, { create: true })).createWritable();
            var reader = res.body.getReader(), loaded = 0;
            for (;;) {
                var chunk = await reader.read();
                if (chunk.done) break;
                await writable.write(chunk.value);
                loaded += chunk.value.length;
                onProgress(loaded, total);
            }
            if (total > 0 && loaded !== total) throw new Error('connection dropped at ' + fmtBytes(loaded) + ' of ' + fmtBytes(total));
            await writable.close();
            writable = null;
            return { ok: true };
        } catch (e) {
            if (aborted) return { aborted: true };
            return { ok: false, error: (e && e.message) || String(e) };
        } finally {
            r.active.delete(token);
            if (writable) {
                try { await writable.abort(); } catch (e) { /* already closed */ }
                // getFileHandle(create) leaves an empty placeholder; drop it if it was ours.
                if (created) { try { await dir.removeEntry(fname); } catch (e) { /* gone or locked */ } }
            }
        }
    }

    // Fallback where the folder picker doesn't exist (Firefox). Whether
    // subfolders are honoured is up to the userscript manager.
    async function saveViaGM(job, r, folder, onProgress) {
        var dl = gmDownload(job.url, folder + '/' + job.savePath, function (e) { onProgress(e.loaded || 0, e.total || 0); });
        r.active.add(dl);
        var res = await dl.promise;
        r.active.delete(dl);
        return res;
    }

    async function downloadJob(job, r) {
        for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (r.cancelled || r.halted) return 'cancelled';
            job.loaded = 0;
            job.total  = 0;
            job.rate   = 0;
            job.row.active(attempt);
            var meter = makeMeter();

            var res = await r.save(job, r, function (loaded, total) {
                if (loaded > job.loaded) r.bytes += loaded - job.loaded;
                job.loaded = loaded;
                if (total > 0) job.total = total;
                job.rate = meter(loaded);
                scheduleRender();
            });

            if (res.ok) return res.existed ? 'existed' : 'done';
            if (res.aborted || r.cancelled) return 'cancelled';

            if (CONFIG_ERRORS[res.error]) {
                r.halted = CONFIG_ERRORS[res.error];
                job.row.error(r.halted);
                return 'error';
            }
            job.lastError = res.error + (res.details ? ': ' + res.details : '');
            if (attempt < MAX_ATTEMPTS) {
                var wait = RETRY_DELAYS_MS[attempt - 1];
                job.row.waiting(job.lastError, wait);
                await sleep(wait, r);
            }
        }
        job.row.error(job.lastError);
        return 'error';
    }

    // -------------------------------------------------------------------------
    // Run a set of jobs through a pool of `concurrency` slots
    // -------------------------------------------------------------------------
    var renderQueued = false;
    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        // A timer, not rAF: rAF stops entirely in a backgrounded window.
        setTimeout(function () { renderQueued = false; render(); }, 150);
    }

    function idleLabel() { return 'DOWNLOAD ' + jobs.length + ' FLAC' + (jobs.length === 1 ? '' : 'S'); }

    function render() {
        if (!run) { fab.textContent = idleLabel(); return; }
        var total = run.jobs.length;
        var frac  = run.finished;
        run.inFlight.forEach(function (j) {
            if (j.total > 0) frac += Math.min(1, j.loaded / j.total);
            if (j.loaded > 0) j.row.progress(j.loaded, j.total, j.rate);
        });
        var pct = total ? Math.floor(frac / total * 100) : 0;
        var tail = (run.existed ? ' · ' + run.existed + ' already there' : '') + (run.failed ? ' · ' + run.failed + ' failed' : '');

        if (run.running) {
            fab.textContent = run.finished + '/' + total + ' FLAC · ' + pct + '%';
            oLabel.textContent = run.finished + ' / ' + total + ' done' + tail;
            oLabel.classList.remove('bad');
            oPct.textContent = pct + '%';
            oBar.style.width = pct + '%';
            var rate = run.meter(run.bytes);
            oRate.textContent = rate > 0 ? fmtSpeed(rate) + ' across ' + run.inFlight.size + ' stream' + (run.inFlight.size === 1 ? '' : 's') : '';
            return;
        }

        fab.textContent = idleLabel();
        var bad = run.cancelled || run.halted || run.failed > 0;
        oLabel.classList.toggle('bad', !!bad);
        oLabel.textContent = run.halted
            ? 'Stopped: ' + run.halted
            : (run.cancelled ? 'Cancelled: ' : 'Done: ') + run.saved + ' / ' + total + ' saved' + tail;
        oPct.textContent = '';
        oBar.style.width = '100%';
        oBar.classList.toggle('bad', !!bad);
        oRate.textContent = '';
    }

    function setRunningUI(running) {
        startBtn.hidden  = running;
        cancelBtn.hidden = !running;
        cancelBtn.disabled = false;
        retryBtn.hidden  = running || unfinished.length === 0;
        retryBtn.textContent = 'RETRY ' + unfinished.length + ' UNFINISHED';
        rootIn.disabled = albumIn.disabled = pickBtn.disabled = running;
        fab.classList.toggle('running', running);
    }

    async function runJobs(list, save) {
        var r = run = {
            jobs: list, save: save, running: true, cancelled: false, halted: null,
            finished: 0, saved: 0, existed: 0, failed: 0, bytes: 0, meter: makeMeter(),
            inFlight: new Set(), active: new Set(), waiters: new Set(), pump: null
        };
        unfinished = [];
        list.forEach(function (j) { j.loaded = j.total = 0; j.row.queued(); });
        overall.hidden = false;
        oBar.classList.remove('bad');
        oBar.style.width = '0%';
        setRunningUI(true);
        render();

        var queue = list.slice();
        await new Promise(function (resolveAll) {
            r.pump = function () {
                while (!r.cancelled && !r.halted && queue.length && r.inFlight.size < concurrency) {
                    var job = queue.shift();
                    r.inFlight.add(job);
                    downloadJob(job, r).then(function (job, result) {
                        r.inFlight.delete(job);
                        r.finished++;
                        if (result === 'done')         { r.saved++; job.row.done(); }
                        else if (result === 'existed') { r.saved++; r.existed++; job.row.existed(); }
                        else {
                            unfinished.push(job);
                            if (result === 'error') r.failed++;
                            else job.row.cancelled();
                        }
                        r.pump();
                    }.bind(null, job));
                }
                if ((r.cancelled || r.halted) && queue.length) {
                    queue.splice(0).forEach(function (j) { j.row.skipped(); unfinished.push(j); });
                }
                scheduleRender();
                if (r.inFlight.size === 0 && queue.length === 0) resolveAll();
            };
            r.pump();
        });

        r.running = false;
        r.pump = null;
        // Keep retry order matching page order.
        unfinished.sort(function (a, b) { return jobs.indexOf(a) - jobs.indexOf(b); });
        setRunningUI(false);
        render();
    }

    // Resolves the destination (asking for the folder / permission if needed)
    // and returns a saver bound to it, or null if the user backed out.
    async function prepareSaver() {
        if (!hasFS) {
            var folder = saveFolder();
            return function (job, r, onProgress) { return saveViaGM(job, r, folder, onProgress); };
        }
        var base = await ensureDir();
        if (!base) return null;
        var sub = saveFolder();
        var dir = base;
        var segs = sub ? sub.split('/') : [];
        for (var i = 0; i < segs.length; i++) dir = await dir.getDirectoryHandle(segs[i], { create: true });
        return function (job, r, onProgress) { return saveViaFS(job, r, dir, onProgress); };
    }

    async function start(list) {
        if (run && run.running) return;
        var save;
        try { save = await prepareSaver(); }
        catch (e) { alert('Can\'t write to that folder: ' + e.message); return; }
        if (save) runJobs(list, save);
    }

    startBtn.addEventListener('click', function () { start(jobs.slice()); });

    retryBtn.addEventListener('click', function () {
        if (unfinished.length) start(unfinished.slice());
    });

    cancelBtn.addEventListener('click', function () {
        if (!run || !run.running) return;
        run.cancelled = true;
        cancelBtn.disabled = true;
        run.active.forEach(function (d) { d.abort(); });
        run.waiters.forEach(function (w) { w(); });
        run.pump();
    });

    render();
})();

