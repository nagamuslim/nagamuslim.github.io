/**
 * update_data.js — AnimeUpdater  (UMD)
 *
 * Parses filtered*.txt exports → groups → syncs anime_data.json / localStorage.
 *
 * Supported formats
 *   [Ani-One]  Title: 《Name》#N (ID Sub/Dub)【Ani-One Indonesia】
 *   [Takarir/Muse]  Anime Name - Episode NN [Takarir Indonesia]
 *   [Tropics]  【Subtitle Indonesia】《Name》｜Episode NN｜TROPICS ENTERTAINMENT
 *
 * Auto-splitting into separate groups (all handled in parseAniOne):
 *   SPECIAL EPISODE 《Name》#N   → "Name (Special)"
 *   《Name》#N (ENCORE)           → "Name (Encore)"
 *   《Name》#N (ID Dub)           → "Name (Dub)"
 *   《Name》Season 2 #N           → "Name Season 2"  (season tag before #N in title)
 *
 * Skipped:
 *   • FULL EPISODE (Ani-One marathon)
 *   • No #N episode number (PV, Movie, Penjelasan, etc.)
 *   • "Semua Episode" (Takarir marathon playlist)
 *   • "Members Only" (Tropics paywall)
 *   • Range where end-start > 3  (big compilations like 01-12, 01-24)
 *     Kept: 01-03, 01-04 (premiere bundles, stored with end_episode field)
 *
 * localStorage (browser):
 *   Key: "anime_data"
 *   Written after every successful merge.
 *   index.html / player.html read localStorage first, fall back to server JSON.
 *
 * Browser API:
 *   AnimeUpdater.parseContent(str)           → Map
 *   AnimeUpdater.parseMultiple([str,...])    → merged Map
 *   AnimeUpdater.mergeData(existing, groups) → { data, stats }
 *   AnimeUpdater.saveLocal(data)             → writes localStorage + returns data
 *   AnimeUpdater.saveData(data, name?)       → File System Access API or download
 *   AnimeUpdater.loadData()                  → localStorage data or null
 *
 * Node:  node update_data.js   (reads filtered*.txt, writes anime_data.json)
 */
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.AnimeUpdater = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    var LS_KEY = 'anime_data';

    // ── Helpers ───────────────────────────────────────────────────────────────

    function extractVideoId(url) {
        var m = (url || '').match(/[?&]v=([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
    }

    function isLargeRange(start, end) { return (end - start) > 3; }

    function buildEntry(name, videos) {
        videos.sort(function(a, b) { return a.episode - b.episode; });
        // Deduplicate by episode number: same ep from two source files = keep first (oldest upload)
        var seen = {};
        videos = videos.filter(function(v) {
            var k = v.episode;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        });
        var first = videos[0];
        return {
            name:               name,
            videos:             videos,
            episode_count:      videos.length,
            thumbnail_video_id: first ? first.video_id : null,
            min_episode:        first ? first.episode  : null,
            marathon_video_id:  null,
            marathon_title:     null
        };
    }

    // ── Ani-One parser ────────────────────────────────────────────────────────
    // Handles all Ani-One variants and splits conflicts into separate groups.

    function parseAniOne(t, urlLine) {
        var video_id = extractVideoId(urlLine);
        if (!video_id) return null;
        if (/^FULL EPISODE/i.test(t)) return null;

        var isSpecial = /^SPECIAL EPISODE/i.test(t);

        var nameM = t.match(/\u300a(.+?)\u300b/);
        if (!nameM) return null;
        var animeName = nameM[1].trim();

        // Must have #N integer (gates out PV, Movie, OVA-text, Penjelasan)
        var epM = t.match(/#(\d+(?:\.\d+)?)/);
        if (!epM) return null;
        var episode = parseFloat(epM[1]);

        // Skip (ID Dub) entirely
        if (/\(ID Dub\)/i.test(t)) return null;

        // Check for (ENCORE) — split into separate group
        var isEncore = /\(ENCORE\)/i.test(t);

        // Check for "Season N" text between 》 and # — means a different season
        // e.g. 《MEGALOBOX》Season 2 #1  →  split to "MEGALOBOX Season 2"
        var betweenNameAndEp = t.substring(t.indexOf('\u300b') + 1, t.indexOf('#')).trim();
        var seasonM = betweenNameAndEp.match(/Season\s+(\d+)/i);
        if (seasonM) {
            animeName = animeName + ' Season ' + seasonM[1];
        }

        if (isSpecial)     animeName = animeName + ' (Special)';
        else if (isEncore) animeName = animeName + ' (Encore)';

        return { animeName: animeName, episode: episode, title: t, url: urlLine, video_id: video_id };
    }

    // ── Takarir / Muse parser ─────────────────────────────────────────────────

    function parseTakarir(t, urlLine) {
        var video_id = extractVideoId(urlLine);
        if (!video_id) return null;
        if (/Semua Episode/i.test(t)) return null;
        if (/\(Live-Action\)/i.test(t)) return null;

        var m = t.match(/^(.+?)\s+-\s+Episode\s*(\d+(?:\s*[-\u2013]\s*\d+)?)\s*\[Takarir Indonesia\]/i);
        if (!m) return null;

        var animeName = m[1].trim();
        var epPart    = m[2].trim();

        var rangeM = epPart.match(/(\d+)\s*[-\u2013]\s*(\d+)/);
        if (rangeM) {
            var s = parseInt(rangeM[1], 10), e = parseInt(rangeM[2], 10);
            if (isLargeRange(s, e)) return null;
            return { animeName: animeName, episode: s, end_episode: e,
                     title: animeName + ' - Episode ' + s + '-' + e, url: urlLine, video_id: video_id };
        }

        var episode = parseInt(epPart, 10);
        return { animeName: animeName, episode: episode,
                 title: animeName + ' - Episode ' + episode, url: urlLine, video_id: video_id };
    }

    // ── Tropics parser ────────────────────────────────────────────────────────

    function parseTropics(t, urlLine) {
        var video_id = extractVideoId(urlLine);
        if (!video_id) return null;
        if (/Members Only/i.test(t)) return null;

        var nameM = t.match(/\u300a(.+?)\u300b/);
        if (!nameM) return null;
        var animeName = nameM[1].trim();

        var epM = t.match(/Episode\s+(\d+)/i);
        if (!epM) return null;
        var episode = parseInt(epM[1], 10);

        return { animeName: animeName, episode: episode,
                 title: animeName + ' - Episode ' + episode, url: urlLine, video_id: video_id };
    }

    function detectAndParse(titleLine, urlLine) {
        var t = titleLine.trim(), u = urlLine.trim();
        if (/\u3010Ani-One/.test(t))                                             return parseAniOne(t, u);
        if (/TROPICS ENTERTAINMENT/.test(t) || /\u3010Subtitle Indonesia\u3011/.test(t)) return parseTropics(t, u);
        if (/\[Takarir Indonesia\]/i.test(t))                                    return parseTakarir(t, u);
        return null;
    }

    // ── Content parser ────────────────────────────────────────────────────────

    function parseContent(content) {
        var groups = new Map();

        var groupIndex = {}; // lowercase name → canonical for this file
        function addVideo(parsed) {
            if (!parsed) return;
            var key = parsed.animeName.toLowerCase();
            var canonical = groupIndex.hasOwnProperty(key) ? groupIndex[key] : parsed.animeName;
            if (!groupIndex.hasOwnProperty(key)) groupIndex[key] = canonical;
            parsed.animeName = canonical;
            if (!groups.has(canonical)) groups.set(canonical, new Map());
            var g = groups.get(canonical);
            if (!g.has(parsed.video_id)) {
                var entry = { title: parsed.title, url: parsed.url,
                              video_id: parsed.video_id, episode: parsed.episode };
                if (parsed.end_episode !== undefined) entry.end_episode = parsed.end_episode;
                g.set(parsed.video_id, entry);
            }
        }

        // Format A: Ani-One (has "Title:" prefix lines + "---" separators)
        if (/^Title:\s/m.test(content)) {
            var blocks = content.split(/^-{10,}$/m);
            for (var i = 0; i < blocks.length; i++) {
                var tM = blocks[i].match(/^Title:\s*(.+)$/m);
                var uM = blocks[i].match(/^URL:\s*(https?:\/\/\S+)/m);
                if (tM && uM) addVideo(detectAndParse(tM[1].trim(), uM[1].trim()));
            }
            return groups;
        }

        // Format B: plain "titleline\nurlline\n\n" (Takarir / Tropics)
        var lines = content.split('\n');
        var idx = 0;
        while (idx < lines.length) {
            var line = lines[idx].trim();
            if (!line || /^https?:\/\//i.test(line)) { idx++; continue; }
            var j = idx + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && /^https?:\/\//i.test(lines[j].trim())) {
                addVideo(detectAndParse(line, lines[j].trim()));
                idx = j + 1;
            } else { idx++; }
        }
        return groups;
    }

    // Merge multiple file contents, deduplicating by video_id across files.
    // Passing the same file twice is safe — video_ids deduplicate naturally.
    function parseMultiple(contentArray) {
        var combined = new Map();
        var nameIndex = {}; // lowercase → canonical across files
        for (var i = 0; i < contentArray.length; i++) {
            var groups = parseContent(contentArray[i]);
            groups.forEach(function(videoMap, animeName) {
                var nkey = animeName.toLowerCase();
                var cname = nameIndex.hasOwnProperty(nkey) ? nameIndex[nkey] : animeName;
                if (!nameIndex.hasOwnProperty(nkey)) nameIndex[nkey] = cname;
                if (!combined.has(cname)) combined.set(cname, new Map());
                var dest = combined.get(cname);
                videoMap.forEach(function(v, vid) { if (!dest.has(vid)) dest.set(vid, v); });
            });
        }
        return combined;
    }

    // ── Merge ─────────────────────────────────────────────────────────────────

    function mergeData(existingData, combinedGroups) {
        var existing    = (existingData && existingData.anime_list) ? existingData.anime_list : [];
        var existingMap = new Map(existing.map(function(e) { return [e.name, e]; }));
        var stats       = { added: 0, updated: 0, removed: 0 };
        var newList     = [];

        combinedGroups.forEach(function(videoMap, animeName) {
            var videos = [];
            videoMap.forEach(function(v) { videos.push(v); });
            if (videos.length === 0) return;
            newList.push(buildEntry(animeName, videos));
            if (!existingMap.has(animeName)) stats.added++;
            else stats.updated++;
        });

        existingMap.forEach(function(_, name) {
            if (!combinedGroups.has(name)) stats.removed++;
        });

        newList.sort(function(a, b) { return a.name.localeCompare(b.name); });

        var now = (typeof Date !== 'undefined') ? new Date().toISOString().slice(0, 10) : 'unknown';
        return {
            data:  { anime_list: newList, total_series: newList.length, last_updated: now },
            stats: stats
        };
    }

    // ── localStorage ──────────────────────────────────────────────────────────

    function saveLocal(dataObj) {
        if (typeof localStorage === 'undefined') return false;
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(dataObj));
            return true;
        } catch(e) {
            // QuotaExceededError or similar
            console.warn('AnimeUpdater: localStorage write failed —', e.message);
            return false;
        }
    }

    function loadLocal() {
        if (typeof localStorage === 'undefined') return null;
        try {
            var raw = localStorage.getItem(LS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    }

    // loadData: localStorage first, then falls back to fetching server JSON.
    // Returns a Promise that resolves to the data object.
    async function loadData(serverJsonUrl) {
        // 1. Try localStorage (synchronous, instant)
        var local = loadLocal();
        if (local && local.anime_list) return local;

        // 2. Fall back to server JSON
        // 2. Try combined.txt from server (same dir as the page)
        if (!data && typeof fetch !== 'undefined') {
            try {
                var base = (typeof location !== 'undefined') ? location.href.replace(/\/[^\/]*$/, '/') : '';
                var r2 = await fetch(base + 'combined.txt', { cache: 'no-cache' });
                if (r2.ok) {
                    var txt = await r2.text();
                    var groups = parseMultiple([txt]);
                    var existing = loadLocal();
                    var merged = mergeData(existing, groups);
                    data = merged.data;
                    saveLocal(data);
                }
            } catch(e) { /* combined.txt not found, fine */ }
        }

        // 3. Fall back to server anime_data.json
        if (typeof fetch !== 'undefined' && serverJsonUrl) {
            try {
                var res  = await fetch(serverJsonUrl);
                var data = await res.json();
                return data;
            } catch(e) { return null; }
        }
        return null;
    }

    // ── Browser file save ─────────────────────────────────────────────────────

    async function saveData(dataObj, suggestedName) {
        suggestedName = suggestedName || 'anime_data.json';
        var json = JSON.stringify(dataObj, null, 2);

        if (typeof window !== 'undefined' && window.showSaveFilePicker) {
            try {
                var handle   = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
                });
                var writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                return { ok: true, method: 'filePicker' };
            } catch(e) {
                if (e.name === 'AbortError') return { ok: false, method: 'cancelled' };
            }
        }

        // Fallback: trigger download
        var blob = new Blob([json], { type: 'application/json' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href = url; a.download = suggestedName;
        document.body.appendChild(a); a.click();
        setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        return { ok: true, method: 'download' };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    var AnimeUpdater = {
        parseContent:  parseContent,
        parseMultiple: parseMultiple,
        mergeData:     mergeData,
        saveLocal:     saveLocal,   // write to localStorage
        loadLocal:     loadLocal,   // read from localStorage (sync)
        loadData:      loadData,    // localStorage → server JSON (async)
        saveData:      saveData     // File System Access API or download
    };

    // ── Node.js auto-run ──────────────────────────────────────────────────────

    if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
        var fs        = require('fs');
        var path      = require('path');
        var DIR       = __dirname;
        var JSON_FILE = path.join(DIR, 'anime_data.json');

        var txtFiles = fs.readdirSync(DIR)
            .filter(function(f) { return /^filtered.*\.txt$/i.test(f); })
            .sort()
            .map(function(f) { return path.join(DIR, f); });

        console.log('Found ' + txtFiles.length + ' filtered*.txt file(s):');
        txtFiles.forEach(function(f) { console.log('   ' + path.basename(f)); });

        if (txtFiles.length === 0) { console.log('Nothing to do.'); process.exit(0); }

        // Deduplicate file paths (handles case where same file listed twice)
        var seenPaths = {};
        var uniqueFiles = txtFiles.filter(function(f) {
            var key = fs.realpathSync(f);
            if (seenPaths[key]) { console.log('   (skipping duplicate: ' + path.basename(f) + ')'); return false; }
            seenPaths[key] = true;
            return true;
        });

        var contents = uniqueFiles.map(function(f) {
            console.log('Parsing ' + path.basename(f) + '...');
            return fs.readFileSync(f, 'utf8');
        });

        var combinedGroups = parseMultiple(contents);
        console.log('Parsed ' + combinedGroups.size + ' unique anime series.');

        var existingData = null;
        if (fs.existsSync(JSON_FILE)) {
            existingData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
            console.log('Loaded existing JSON: ' + existingData.anime_list.length + ' entries.');
        } else {
            console.log('No existing anime_data.json — creating fresh.');
        }

        var existingMap = existingData
            ? new Map(existingData.anime_list.map(function(e) { return [e.name, e]; }))
            : new Map();

        var result = mergeData(existingData, combinedGroups);
        var data = result.data, stats = result.stats;

        combinedGroups.forEach(function(_, name) { if (!existingMap.has(name)) console.log('  + ADD: ' + name); });
        existingMap.forEach(function(_, name)    { if (!combinedGroups.has(name)) console.log('  - REMOVE: ' + name); });

        fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
        var totalEps = data.anime_list.reduce(function(s, a) { return s + a.episode_count; }, 0);
        console.log('\nDone! anime_data.json updated.');
        console.log('  Series: ' + data.total_series + ' | Episodes: ' + totalEps);
        console.log('  Added: ' + stats.added + ' | Updated: ' + stats.updated + ' | Removed: ' + stats.removed);
    }

    return AnimeUpdater;
}));
