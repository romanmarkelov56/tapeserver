'use strict';

const LS_KEY = 'tape-server-v1';
const API_ROOT = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36';

const DEFAULTS = {
  clientId: '',
  quality: 'mp3_128',
  demo: true,
  routes: {
    health: '/health',
    search: '/api/search',
    track: '/api/tracks/:id',
    playlist: '/api/playlists/:id',
    resolve: '/api/resolve',
    stream: '/api/stream/:id',
    download: '/api/download/:id'
  }
};

let state = load();
let current = null;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return { ...DEFAULTS, ...raw, routes: { ...DEFAULTS.routes, ...(raw.routes || {}) } };
  } catch { return structuredClone(DEFAULTS); }
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

function toast(msg, err) {
  const el = document.querySelector('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!err);
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- демо-каталог ---------- */

function art(text, hue) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(' + hue + ' 40% 18%)"/><text x="48" y="60" font-family="monospace" font-size="28" fill="hsl(' + hue + ' 85% 68%)" text-anchor="middle">' + text + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function wavUri(seconds, freq) {
  const rate = 16000, n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 10) * Math.max(0, 1 - t / seconds);
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * freq * t) * env * 11000, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return 'data:audio/wav;base64,' + btoa(bin);
}

const MOCK = [
  ['Night Drive', 'Kova', 'synthwave', 194000, 320],
  ['Cold Harbor', 'Mira Set', 'ambient', 236000, 262],
  ['Paper Ghosts', 'Rellix', 'trip-hop', 168000, 196],
  ['Signal Lost', 'Anhedonia', 'techno', 305000, 392],
  ['Velvet Static', 'Blue Ache', 'shoegaze', 221000, 174],
  ['Third Shift', 'Dorn', 'drum & bass', 252000, 349],
  ['Glass Corridor', 'Yuna Ferro', 'downtempo', 205000, 233],
  ['Last Train West', 'Kova', 'synthwave', 287000, 294]
].map((r, i) => ({
  id: 900 + i,
  title: r[0],
  artist: r[1],
  genre: r[2],
  duration: r[3],
  artwork_url: art(r[1][0], (i * 47) % 360),
  permalink_url: 'https://soundcloud.com/demo/' + r[0].toLowerCase().replace(/\W+/g, '-'),
  stream_url: wavUri(1.2, r[4]),
  download_url: null,
  created_at: new Date(Date.UTC(2024, 5, 1 + i)).toISOString()
}));

MOCK.forEach(t => { t.download_url = t.stream_url; });

/* ---------- нормализация ---------- */

function link(tpl, id) { return tpl.replace(':id', String(id)); }

function normalize(t) {
  return {
    id: t.id,
    title: t.title || '—',
    artist: (t.user && t.user.username) || t.artist || 'unknown',
    artwork_url: (t.artwork_url || '').replace('-large', '-t200') || '',
    duration: t.duration || 0,
    genre: t.genre || '',
    permalink_url: t.permalink_url || '',
    created_at: t.created_at || '',
    stream_url: link(state.routes.stream, t.id),
    download_url: link(state.routes.download, t.id)
  };
}

function pickTranscoding(track) {
  const list = (track.media && track.media.transcodings) || [];
  const prog = list.filter(t => t.format && t.format.protocol === 'progressive');
  const rank = t => {
    const q = t.quality || '';
    if (q.startsWith('mp3_original') || q.startsWith('aac_original')) return 0;
    if (q.startsWith('mp3_128')) return 1;
    if (q.startsWith('aac')) return 2;
    return 5;
  };
  prog.sort((a, b) => rank(a) - rank(b));
  return prog[0] || list[0] || null;
}

async function sc(path, params) {
  const url = new URL(API_ROOT + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  if (state.clientId) url.searchParams.set('client_id', state.clientId);
  const res = await fetch(url.toString(), { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error('SoundCloud ' + res.status);
  return res.json();
}

async function streamUrl(track) {
  if (state.demo || !track.id || String(track.id).startsWith('demo')) return track.stream_url;
  const full = await sc('/tracks/' + track.id, {});
  const tc = pickTranscoding(full);
  if (!tc) throw new Error('нет доступного потока');
  const id = state.clientId;
  const sep = tc.url.includes('?') ? '&' : '?';
  const r = await fetch(tc.url + sep + 'client_id=' + id, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('поток ' + r.status);
  const j = await r.json();
  return j.url;
}

/* ---------- поиск и плеер ---------- */

function render(list) {
  const box = document.querySelector('#results');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="hint">Ничего не найдено.</p>';
    return;
  }
  list.forEach(t => {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.src = t.artwork_url;
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<div class="t"></div><div class="s"></div>';
    meta.querySelector('.t').textContent = t.title;
    meta.querySelector('.s').textContent = t.artist + ' · ' + t.genre + ' · ' + Math.round(t.duration / 1000) + ' c';
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.onclick = () => select(t);
    const dl = document.createElement('button');
    dl.className = 'ghost';
    dl.textContent = '↓';
    dl.onclick = () => download(t);
    card.append(img, meta, play, dl);
    box.append(card);
  });
}

async function select(t) {
  current = t;
  document.querySelector('#now').textContent = t.artist + ' — ' + t.title;
  document.querySelector('#btn-download').disabled = false;
  document.querySelector('#btn-copy').disabled = false;
  try {
    const url = await streamUrl(t);
    const audio = document.querySelector('#audio');
    audio.src = url;
    audio.play().catch(() => {});
  } catch (e) {
    toast(e.message, true);
  }
}

async function download(t) {
  const target = t || current;
  if (!target) return;
  try {
    const url = await streamUrl(target);
    const name = (target.artist + ' - ' + target.title).replace(/[\\/:*?"<>|]/g, '_') + '.mp3';
    if (url.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = name.replace(/\.mp3$/, '.wav');
      a.click();
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error('скачивание ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    toast('Файл получен');
  } catch (e) {
    toast(e.message, true);
  }
}

async function doSearch(q) {
  if (!q.trim()) return;
  const box = document.querySelector('#results');
  box.innerHTML = '<p class="hint">Поиск…</p>';
  try {
    if (state.demo) {
      const s = q.toLowerCase();
      render(MOCK.filter(t => (t.title + ' ' + t.artist + ' ' + t.genre).toLowerCase().includes(s)));
      return;
    }
    const data = await sc('/search/tracks', { q, limit: 25 });
    render((data.collection || []).filter(t => t.streamable !== false).map(normalize));
  } catch (e) {
    box.innerHTML = '<p class="hint">' + e.message + ' — включён демо-режим.</p>';
    state.demo = true;
    save();
    syncStatus();
    render(MOCK);
  }
}

/* ---------- API-консоль ---------- */

const SAMPLES = [
  ['health', ''],
  ['search', '?q=night'],
  ['track', '/901'],
  ['playlist', '/555'],
  ['resolve', '?url=https://soundcloud.com/demo/night-drive'],
  ['stream', '/901?redirect=0'],
  ['download', '/901']
];

function fillChips() {
  const box = document.querySelector('#api-chips');
  box.innerHTML = '';
  SAMPLES.forEach(([key, tail]) => {
    const b = document.createElement('button');
    b.textContent = key;
    b.onclick = () => {
      const base = state.routes[key] || ('/api/' + key);
      document.querySelector('#api-path').value = base.replace(':id', '') + tail;
    };
    box.append(b);
  });
}

async function runApi() {
  const path = document.querySelector('#api-path').value.trim();
  const out = document.querySelector('#api-out');
  if (!path) return;
  try {
    if (path === state.routes.health) {
      out.textContent = JSON.stringify({ ok: true, mode: state.demo ? 'demo' : 'live', client_id: state.clientId ? 'set' : 'auto' }, null, 2);
      return;
    }
    if (state.demo) {
      out.textContent = JSON.stringify(demoResponse(path), null, 2);
      return;
    }
    const res = await fetch(path.startsWith('http') ? path : location.origin + path);
    const text = await res.text();
    try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); }
    catch { out.textContent = text.slice(0, 4000); }
  } catch (e) {
    out.textContent = '// ' + e.message;
  }
}

function demoResponse(path) {
  const id = Number((path.match(/\d+/) || [0])[0]) || 901;
  const track = MOCK.find(t => t.id === id) || MOCK[0];
  if (path.includes('download')) return { id: track.id, file: normalize(track).download_url, format: 'mp3' };
  if (path.includes('stream')) return { id: track.id, url: track.stream_url, expires_in: 3600 };
  if (path.includes('playlist')) return { id: 555, title: 'Demo playlist', track_count: 2, tracks: MOCK.slice(0, 2).map(normalize) };
  if (path.includes('resolve')) return normalize(track);
  if (path.includes('search')) return { collection: MOCK.slice(0, 3).map(normalize), next_href: null };
  return normalize(track);
}

/* ---------- карта маршрутов ---------- */

function renderRoutes() {
  const box = document.querySelector('#routes-list');
  box.innerHTML = '';
  Object.entries(state.routes).forEach(([key, val]) => {
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.textContent = key;
    const input = document.createElement('input');
    input.value = val;
    input.dataset.key = key;
    input.spellcheck = false;
    label.append(span, input);
    box.append(label);
  });
}

/* ---------- серверный код ---------- */

function serverCode() {
  const r = state.routes;
  const routesJson = JSON.stringify(r, null, 2);
  return [
    '// tape-server.js — мост Tape -> SoundCloud. Node 20+, CommonJS.',
    '// npm i express',
    '// SC_CLIENT_ID=xxxx PORT=8080 node tape-server.js',
    "'use strict';",
    "const express = require('express');",
    "const { Readable } = require('node:stream');",
    'const app = express();',
    '',
    'const PORT = Number(process.env.PORT || 8080);',
    'const UA = ' + JSON.stringify(UA) + ';',
    "const API = 'https://api-v2.soundcloud.com';",
    'const TTL = 10 * 60 * 1000;',
    'const ROUTES = ' + routesJson + ';',
    '',
    "let clientId = process.env.SC_CLIENT_ID || '';",
    'let stamp = clientId ? Date.now() : 0;',
    'const cache = new Map();',
    '',
    'function cached(key, fn) {',
    '  const hit = cache.get(key);',
    '  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.val);',
    '  return fn().then(function (val) {',
    '    cache.set(key, { val: val, at: Date.now() });',
    '    if (cache.size > 400) cache.delete(cache.keys().next().value);',
    '    return val;',
    '  });',
    '}',
    '',
    'async function getClientId(force) {',
    '  if (!force && clientId && Date.now() - stamp < 30 * 60 * 1000) return clientId;',
    "  const html = await fetch('https://soundcloud.com/', { headers: { 'user-agent': UA } }).then(function (r) { return r.text(); });",
    '  const scripts = Array.from(html.matchAll(/src="(https:\\/\\/a-v2\\.sndcdn\\.com\\/assets\\/[^"]+\\.js)"/g)).map(function (m) { return m[1]; });',
    '  for (const src of scripts.slice(-8)) {',
    "    const js = await fetch(src, { headers: { 'user-agent': UA } }).then(function (r) { return r.text(); }).catch(function () { return ''; });",
    "    const m = js.match(/client_id:\"([A-Za-z0-9]{32})\"/) || js.match(/client_id=([A-Za-z0-9]{32})/);",
    '    if (m) { clientId = m[1]; stamp = Date.now(); return clientId; }',
    '  }',
    "  if (clientId) return clientId;",
    "  throw new Error('client_id не найден — задай SC_CLIENT_ID');",
    '}',
    '',
    'async function sc(path, params, retry) {',
    '  const id = await getClientId(retry);',
    '  const url = new URL(API + path);',
    '  Object.keys(params || {}).forEach(function (k) { if (params[k] != null) url.searchParams.set(k, params[k]); });',
    "  url.searchParams.set('client_id', id);",
    "  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });",
    '  if (res.status === 401 && !retry) return sc(path, params, true);',
    "  if (!res.ok) throw new Error('SoundCloud ' + res.status);",
    '  return res.json();',
    '}',
    '',
    'function link(tpl, id) { return tpl.replace(\':id\', String(id)); }',
    '',
    'function normalize(t) {',
    '  return {',
    '    id: t.id,',
    "    title: t.title || '—',",
    "    artist: (t.user && t.user.username) || 'unknown',",
    "    artwork_url: (t.artwork_url || '').replace('-large', '-t200'),",
    '    duration: t.duration || 0,',
    "    genre: t.genre || '',",
    "    permalink_url: t.permalink_url || '',",
    '    created_at: t.created_at || null,',
    '    stream_url: link(ROUTES.stream, t.id),',
    '    download_url: link(ROUTES.download, t.id)',
    '  };',
    '}',
    '',
    'function pick(track) {',
    '  const list = (track.media && track.media.transcodings) || [];',
    '  const prog = list.filter(function (t) { return t.format && t.format.protocol === "progressive"; });',
    '  const rank = function (t) {',
    '    const q = t.quality || "";',
    '    if (q.indexOf("mp3_original") === 0 || q.indexOf("aac_original") === 0) return 0;',
    '    if (q.indexOf("mp3_128") === 0) return 1;',
    '    if (q.indexOf("aac") === 0) return 2;',
    '    return 5;',
    '  };',
    '  prog.sort(function (a, b) { return rank(a) - rank(b); });',
    '  return prog[0] || list[0] || null;',
    '}',
    '',
    'async function directUrl(id) {',
    '  const track = await cached("t" + id, function () { return sc("/tracks/" + id, {}); });',
    '  const tc = pick(track);',
    "  if (!tc) throw new Error('нет потока');",
    '  const cid = await getClientId();',
    "  const sep = tc.url.indexOf('?') > -1 ? '&' : '?';",
    "  const res = await fetch(tc.url + sep + 'client_id=' + cid, { headers: { 'user-agent': UA } });",
    "  if (!res.ok) throw new Error('stream ' + res.status);",
    '  const json = await res.json();',
    '  return { url: json.url, track: track };',
    '}',
    '',
    'function safeName(t) {',
    '  const base = ((t.user && t.user.username) || "tape") + " - " + (t.title || "track");',
    '  return base.replace(/[\\\\/:*?"<>|]+/g, "_").slice(0, 120);',
    '}',
    '',
    'function isPlayable(t) { return t && t.streamable !== false && t.policy !== "BLOCK"; }',
    '',
    "app.use(function (req, res, next) {",
    "  res.setHeader('access-control-allow-origin', '*');",
    "  res.setHeader('access-control-allow-headers', '*');",
    "  if (req.method === 'OPTIONS') return res.sendStatus(204);",
    '  next();',
    '});',
    '',
    'app.get(ROUTES.health, async function (req, res) {',
    '  try { await getClientId(); res.json({ ok: true }); }',
    '  catch (e) { res.status(502).json({ ok: false, error: e.message }); }',
    '});',
    '',
    'app.get(ROUTES.search, async function (req, res, next) {',
    '  try {',
    '    const q = String(req.query.q || "").trim();',
    "    if (!q) return res.status(400).json({ error: 'q required' });",
    '    const key = "s:" + q + ":" + (req.query.offset || 0);',
    '    const data = await cached(key, function () {',
    '      return sc("/search/tracks", { q: q, limit: req.query.limit || 25, offset: req.query.offset || 0 });',
    '    });',
    '    const list = (data.collection || []).filter(isPlayable).map(normalize);',
    '    res.json({ collection: list, next_href: data.next_href || null });',
    '  } catch (e) { next(e); }',
    '});',
    '',
    'app.get(ROUTES.track, async function (req, res, next) {',
    '  try { const t = await sc("/tracks/" + req.params.id, {}); res.json(normalize(t)); }',
    '  catch (e) { next(e); }',
    '});',
    '',
    'app.get(ROUTES.playlist, async function (req, res, next) {',
    '  try {',
    '    const p = await sc("/playlists/" + req.params.id, {});',
    '    res.json({',
    '      id: p.id, title: p.title, track_count: p.track_count,',
    '      artwork_url: p.artwork_url || null,',
    '      tracks: (p.tracks || []).filter(isPlayable).map(normalize)',
    '    });',
    '  } catch (e) { next(e); }',
    '});',
    '',
    'app.get(ROUTES.resolve, async function (req, res, next) {',
    '  try {',
    '    const url = String(req.query.url || "");',
    "    if (!url) return res.status(400).json({ error: 'url required' });",
    '    const data = await sc("/resolve", { url: url });',
    '    if (data.kind === "playlist") {',
    '      return res.json({ kind: "playlist", id: data.id, title: data.title, tracks: (data.tracks || []).filter(isPlayable).map(normalize) });',
    '    }',
    '    res.json(Object.assign({ kind: "track" }, normalize(data)));',
    '  } catch (e) { next(e); }',
    '});',
    '',
    'app.get(ROUTES.stream, async function (req, res, next) {',
    '  try {',
    '    const d = await directUrl(req.params.id);',
    "    if (req.query.redirect === '0') return res.json({ url: d.url });",
    '    res.redirect(302, d.url);',
    '  } catch (e) { next(e); }',
    '});',
    '',
    'app.get(ROUTES.download, async function (req, res, next) {',
    '  try {',
    '    const d = await directUrl(req.params.id);',
    '    const headers = { "user-agent": UA };',
    '    if (req.headers.range) headers.range = req.headers.range;',
    '    const up = await fetch(d.url, { headers: headers });',
    '    if (!up.ok && up.status !== 206) throw new Error("download " + up.status);',
    '    res.status(up.status);',
    '    ["content-length", "accept-ranges", "content-range"].forEach(function (h) {',
    '      const v = up.headers.get(h);',
    '      if (v) res.setHeader(h, v);',
    '    });',
    '    res.setHeader("content-type", "audio/mpeg");',
    '    res.setHeader("content-disposition", "attachment; filename=\\"" + safeName(d.track) + ".mp3\\"");',
    '    Readable.fromWeb(up.body).pipe(res);',
    '  } catch (e) { next(e); }',
    '});',
    '',
    'app.get("/", function (req, res) {',
    '  res.type("text/plain").send("Tape server\\n" + Object.keys(ROUTES).map(function (k) { return k + ": " + ROUTES[k]; }).join("\\n"));',
    '});',
    '',
    'app.use(function (err, req, res, next) {',
    '  console.error(err.message);',
    '  res.status(502).json({ error: err.message });',
    '});',
    '',
    'app.listen(PORT, function () { console.log("tape-server on :" + PORT); });'
  ].join('\n');
}

/* ---------- служебное ---------- */

function syncStatus() {
  const el = document.querySelector('#status');
  el.textContent = state.demo ? 'demo' : 'live';
  el.classList.toggle('live', !state.demo);
}

function refreshDeploy() {
  document.querySelector('#server-code').textContent = serverCode();
}

function bind() {
  document.querySelector('#tabs').addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'deploy') refreshDeploy();
    if (btn.dataset.tab === 'routes') renderRoutes();
    if (btn.dataset.tab === 'api') fillChips();
  });

  document.querySelector('#search-form').addEventListener('submit', ev => {
    ev.preventDefault();
    doSearch(document.querySelector('#q').value);
  });

  document.querySelector('#btn-download').onclick = () => download(current);
  document.querySelector('#btn-copy').onclick = async () => {
    if (!current) return;
    try {
      const url = await streamUrl(current);
      await navigator.clipboard.writeText(url);
      toast('URL скопирован');
    } catch (e) { toast(e.message, true); }
  };

  document.querySelector('#api-run').onclick = runApi;

  document.querySelector('#routes-save').onclick = () => {
    document.querySelectorAll('#routes-list input').forEach(i => { state.routes[i.dataset.key] = i.value.trim() || state.routes[i.dataset.key]; });
    save();
    fillChips();
    refreshDeploy();
    toast('Карта сохранена');
  };

  document.querySelector('#routes-reset').onclick = () => {
    state.routes = structuredClone(DEFAULTS.routes);
    save();
    renderRoutes();
    refreshDeploy();
    toast('Сброшено');
  };

  document.querySelector('#code-copy').onclick = async () => {
    const code = serverCode();
    try {
      await navigator.clipboard.writeText(code);
      toast('Код скопирован');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Код скопирован');
    }
  };

  document.querySelector('#code-download').onclick = () => {
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(serverCode());
    a.download = 'tape-server.js';
    a.click();
  };

  document.querySelector('#set-client').value = state.clientId;
  document.querySelector('#set-quality').value = state.quality;
  document.querySelector('#set-demo').checked = state.demo;

  document.querySelector('#set-save').onclick = () => {
    state.clientId = document.querySelector('#set-client').value.trim();
    state.quality = document.querySelector('#set-quality').value;
    state.demo = document.querySelector('#set-demo').checked;
    save();
    syncStatus();
    toast('Настройки сохранены');
  };

  document.querySelector('#btn-scrape').onclick = async () => {
    const out = document.querySelector('#set-out');
    out.textContent = '// ищу client_id…';
    try {
      const html = await fetch('https://soundcloud.com/').then(r => r.text());
      const scripts = Array.from(html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)).map(m => m[1]);
      let found = '';
      for (const src of scripts.slice(-6)) {
        const js = await fetch(src).then(r => r.text()).catch(() => '');
        const m = js.match(/client_id:"([A-Za-z0-9]{32})"/) || js.match(/client_id=([A-Za-z0-9]{32})/);
        if (m) { found = m[1]; break; }
      }
      if (!found) throw new Error('не найден');
      state.clientId = found;
      save();
      document.querySelector('#set-client').value = found;
      out.textContent = '// найдено: ' + found;
      toast('client_id получен');
    } catch (e) {
      out.textContent = '// ' + e.message + ' — превью офлайн, работает после экспорта';
    }
  };
}

syncStatus();
bind();
render(MOCK);
fillChips();
refreshDeploy();
console.log('tape-server workspace ready');