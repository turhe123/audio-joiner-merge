// app.js — Audio Joiner and Merger. Everything runs on this device: files are decoded with the Web Audio API,
// stitched into Float32 arrays here, and encoded to MP3 (lamejs) or WAV in worker.js. Nothing is uploaded.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const list = $('track-list');
const empty = $('tracks-empty');
const summary = $('summary');
const keysTip = $('tracks-keys');
const results = $('results');
const joinBtn = $('join');
const clearBtn = $('clear');
const gapInput = $('gap');
const xfInput = $('crossfade');
const formatSel = $('format');
const bitrateSel = $('bitrate');
const nameInput = $('out-name');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
const progressEl = progressWrap.querySelector('.progress');

const MAX_SECONDS = 2 * 60 * 60; // memory ceiling stated in the interface
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|m4b|aac|flac|webm|weba|mp4|aif|aiff|aifc|caf|amr|3gp|wma|mka)$/i;

/** @type {{id:number, file:File, status:'probing'|'ok'|'error', duration:number, channels:number, rate:number|null, error:string}[]} */
let tracks = [];
let nextId = 1;
let busy = false;
let probeChain = Promise.resolve();
let dragId = null;
let playerUrl = null;

// ---------- helpers ----------
function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const fmtRate = (r) => `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz`;
const chanLabel = (n) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`);

function isAudioFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('audio/')) return true;
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/ogg' || t === 'video/3gpp') return true;
  return AUDIO_EXT.test(file.name);
}

function outputName() {
  const raw = nameInput.value.trim().replace(/\.(mp3|wav)$/i, '');
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  return `${safe || 'joined'}.${formatSel.value}`;
}

function numberFrom(el, min, max) {
  const v = parseFloat(el.value);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function clearAlerts() { results.querySelectorAll('.alert').forEach((a) => a.remove()); }

function showError(message) {
  const el = document.createElement('div');
  el.className = 'alert alert--error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  results.prepend(el);
  return el;
}

// Reads the native sample rate from the first bytes of common formats, so the output can follow the first file.
// decodeAudioData always resamples to its context's rate, so the header is the only place to learn it.
async function sniffRate(file) {
  const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const u32le = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (b.length < 16) return null;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    for (let o = 12; o + 8 <= b.length;) {
      const size = u32le(o + 4);
      if (ascii(o, 4) === 'fmt ') return u32le(o + 12);
      o += 8 + size + (size & 1);
    }
    return null;
  }
  if (ascii(0, 4) === 'fLaC') return ((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) || null;
  if (ascii(0, 4) === 'OggS') {
    for (let i = 0; i < Math.min(b.length - 16, 512); i++) {
      if (b[i] === 1 && ascii(i + 1, 6) === 'vorbis') return u32le(i + 12);
      if (ascii(i, 8) === 'OpusHead') return 48000;
    }
    return null;
  }
  if ((ascii(0, 4) === 'FORM') && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return null;
  // MP3: skip an ID3v2 tag, then find the first plausible frame header.
  let start = 0;
  if (ascii(0, 3) === 'ID3') start = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  if (start < b.length - 4) {
    for (let i = start; i < b.length - 4 && i < start + 8192; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3;
      const layer = (b[i + 1] >> 1) & 3;
      const brIdx = b[i + 2] >> 4;
      const srIdx = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || brIdx === 15 || brIdx === 0 || srIdx === 3) continue;
      const base = [44100, 48000, 32000][srIdx];
      return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
    }
  }
  return null;
}

// OfflineAudioContext needs no user gesture (Safari) and never plays sound; decodeAudioData resamples to its rate.
async function decodeAt(file, rate) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate);
  return ctx.decodeAudioData(data);
}

// ---------- list ----------
function rowFor(id) { return list.querySelector(`li[data-id="${id}"]`); }

function buildRow(t) {
  const li = document.createElement('li');
  li.className = 'track';
  li.tabIndex = 0;
  li.draggable = true;
  li.dataset.id = String(t.id);
  li.innerHTML = `
    <span class="track__handle" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
    <span class="track__num" aria-hidden="true"></span>
    <div class="track__meta">
      <div class="track__name"></div>
      <div class="track__info"></div>
      <div class="track__error alert alert--error" role="alert" hidden></div>
    </div>
    <div class="track__btns">
      <button class="btn btn--small btn--ghost" type="button" data-act="up">↑</button>
      <button class="btn btn--small btn--ghost" type="button" data-act="down">↓</button>
      <button class="btn btn--small btn--ghost btn--danger" type="button" data-act="remove">✕</button>
    </div>`;
  li.querySelector('.track__name').textContent = t.file.name;
  li.querySelector('.track__name').title = t.file.name;
  li.querySelector('[data-act="up"]').setAttribute('aria-label', `Move ${t.file.name} up`);
  li.querySelector('[data-act="down"]').setAttribute('aria-label', `Move ${t.file.name} down`);
  li.querySelector('[data-act="remove"]').setAttribute('aria-label', `Remove ${t.file.name}`);
  return li;
}

function updateRow(t, index) {
  const li = rowFor(t.id);
  if (!li) return;
  li.querySelector('.track__num').textContent = String(index + 1);
  const info = li.querySelector('.track__info');
  const err = li.querySelector('.track__error');
  const dup = tracks.filter((x) => x.file.name === t.file.name).length > 1 ? ' · same name as another row' : '';
  li.classList.toggle('is-error', t.status === 'error');
  if (t.status === 'probing') {
    info.textContent = `Reading… · ${formatBytes(t.file.size)}`;
    li.dataset.duration = '';
  } else if (t.status === 'ok') {
    const extra = [t.rate ? fmtRate(t.rate) : '', chanLabel(t.channels)].filter(Boolean).join(' ');
    info.innerHTML = `<span class="track__dur"></span> · ${formatBytes(t.file.size)} · ${extra}${dup}`;
    info.querySelector('.track__dur').textContent = fmtTime(t.duration);
    li.dataset.duration = t.duration.toFixed(3);
  } else {
    info.textContent = `${formatBytes(t.file.size)} · will be skipped`;
    li.dataset.duration = '';
  }
  err.hidden = t.status !== 'error';
  err.textContent = t.status === 'error' ? t.error : '';
  li.querySelector('[data-act="up"]').disabled = index === 0;
  li.querySelector('[data-act="down"]').disabled = index === tracks.length - 1;
  const state = t.status === 'ok' ? fmtTime(t.duration) : t.status === 'probing' ? 'reading' : 'cannot be decoded';
  li.setAttribute('aria-label', `${index + 1}. ${t.file.name}, ${state}`);
}

function render(focusId) {
  const have = new Set(tracks.map((t) => String(t.id)));
  [...list.children].forEach((li) => { if (!have.has(li.dataset.id)) li.remove(); });
  tracks.forEach((t, i) => {
    let li = rowFor(t.id);
    if (!li) li = buildRow(t);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    updateRow(t, i);
  });
  const hasRows = tracks.length > 0;
  list.hidden = !hasRows;
  empty.hidden = hasRows;
  keysTip.hidden = !hasRows;
  clearBtn.hidden = !hasRows;
  if (focusId != null) rowFor(focusId)?.focus();
  updateSummary();
}

function okTracks() { return tracks.filter((t) => t.status === 'ok'); }

function targetFormat(first) {
  let rate = first.rate || 44100;
  const fmt = formatSel.value;
  if (fmt === 'mp3' && !MP3_RATES.includes(rate)) {
    rate = MP3_RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best), 44100);
  }
  const channels = okTracks().some((t) => t.channels > 1) ? 2 : 1;
  let kbps = Number(bitrateSel.value);
  if (fmt === 'mp3' && rate < 32000) kbps = Math.min(kbps, 160); // MPEG-2 layer III tops out at 160 kbps
  return { rate, channels, kbps, fmt };
}

// Frame layout of the joined result: where each clip starts and how much it overlaps its neighbours.
function layout(items, rate, gapSec, xfSec) {
  const lens = items.map((t) => Math.max(1, Math.round(t.duration * rate)));
  const gap = xfSec > 0 ? 0 : Math.round(gapSec * rate);
  const offsets = [];
  const head = new Array(lens.length).fill(0);
  const tail = new Array(lens.length).fill(0);
  let pos = 0;
  for (let i = 0; i < lens.length; i++) {
    if (i > 0) {
      // Greedy: a crossfade can use at most what is left of the previous clip and all of the next one.
      const xf = Math.max(0, Math.min(Math.round(xfSec * rate), lens[i - 1] - head[i - 1], lens[i]));
      tail[i - 1] = xf;
      head[i] = xf;
      pos += gap - xf;
    }
    offsets.push(pos);
    pos += lens[i];
  }
  return { lens, offsets, head, tail, total: pos };
}

function updateSummary() {
  const ok = okTracks();
  const probing = tracks.some((t) => t.status === 'probing');
  joinBtn.disabled = busy || probing || ok.length === 0;
  joinBtn.textContent = ok.length > 1 ? `Join ${ok.length} files` : 'Join files';
  gapInput.disabled = numberFrom(xfInput, 0, 10) > 0;
  bitrateSel.disabled = formatSel.value !== 'mp3';
  if (!tracks.length) { summary.hidden = true; summary.textContent = ''; return; }
  summary.hidden = false;
  if (!ok.length) {
    summary.textContent = probing ? 'Reading files…' : 'None of these files could be decoded.';
    summary.dataset.totalSeconds = '';
    return;
  }
  const tf = targetFormat(ok[0]);
  const lay = layout(ok, tf.rate, numberFrom(gapInput, 0, 60), numberFrom(xfInput, 0, 10));
  const totalSec = lay.total / tf.rate;
  summary.dataset.totalSeconds = totalSec.toFixed(3);
  summary.replaceChildren();
  const head = document.createElement('span');
  head.className = 'summary__total';
  head.textContent = `${ok.length} file${ok.length > 1 ? 's' : ''} · total ${fmtTime(totalSec)} · ${fmtRate(tf.rate)} ${chanLabel(tf.channels)}${probing ? ' · still reading…' : ''}`;
  const order = document.createElement('span');
  order.className = 'summary__order';
  order.id = 'summary-order';
  order.textContent = `Order: ${ok.map((t) => t.file.name).join(' → ')}`;
  summary.append(head, order);
  if (totalSec > MAX_SECONDS) {
    const warn = document.createElement('span');
    warn.className = 'stat--danger';
    warn.textContent = 'This is longer than about 2 hours, which is more than most devices can hold in memory.';
    summary.append(warn);
  }
}

function move(id, delta) {
  const i = tracks.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= tracks.length || busy) return;
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  render(id);
}

function removeTrack(id, focusNext) {
  if (busy) return;
  const i = tracks.findIndex((t) => t.id === id);
  if (i < 0) return;
  tracks.splice(i, 1);
  const next = tracks[Math.min(i, tracks.length - 1)];
  render(focusNext && next ? next.id : undefined);
  if (focusNext && !next) zone.focus();
}

// ---------- adding files ----------
function handleFiles(files) {
  if (busy) { toast('Wait for the current join to finish'); return probeChain; }
  clearAlerts();
  const rejected = [];
  const added = [];
  for (const file of files) {
    if (!isAudioFile(file)) { rejected.push(file.name); continue; }
    const t = { id: nextId++, file, status: 'probing', duration: 0, channels: 0, rate: null, error: '' };
    tracks.push(t);
    added.push(t);
  }
  if (rejected.length) {
    showError(`${rejected.length === 1 ? `“${rejected[0]}” is not an audio file` : `${rejected.length} files are not audio files (${rejected.join(', ')})`} and ${rejected.length === 1 ? 'was' : 'were'} skipped. Add MP3, WAV, OGG, M4A, FLAC or other audio files.`);
  }
  render();
  for (const t of added) {
    probeChain = probeChain.then(() => probe(t));
  }
  if (added.length) toast(`${added.length} file${added.length > 1 ? 's' : ''} added — nothing was uploaded`);
  return probeChain;
}

async function probe(t) {
  try {
    t.rate = await sniffRate(t.file).catch(() => null);
    let buf;
    try { buf = await decodeAt(t.file, 8000); } catch (e) {
      if (e && e.name === 'NotSupportedError' && /sample ?rate/i.test(e.message)) buf = await decodeAt(t.file, 22050);
      else throw e;
    }
    t.duration = buf.duration;
    t.channels = buf.numberOfChannels;
    if (!(t.duration > 0)) throw new Error('empty');
    t.status = 'ok';
  } catch {
    t.status = 'error';
    t.error = 'This browser could not decode this file (some M4A, FLAC or damaged files cannot be read). It will be skipped.';
  }
  if (tracks.includes(t)) render();
}

// ---------- joining ----------
function setProgress(fraction, label) {
  const pct = Math.floor(Math.max(0, Math.min(1, fraction)) * 1000) / 10; // floor: 99.9% is not 100%
  progressBar.style.width = `${pct}%`;
  progressEl.setAttribute('aria-valuenow', String(Math.floor(pct)));
  progressLabel.textContent = `${label} ${pct.toFixed(pct % 1 ? 1 : 0)}%`;
}

function runWorker(channels, rate, fmt, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker('worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.value);
      else if (m.type === 'done') { w.terminate(); resolve(m.blob); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The encoder failed to start')); };
    w.postMessage({ channels, sampleRate: rate, format: fmt, kbps }, channels.map((c) => c.buffer));
  });
}

async function join() {
  if (busy || joinBtn.disabled) return;
  const items = okTracks();
  if (!items.length) return;
  clearAlerts();
  const { rate, channels: outCh, kbps, fmt } = targetFormat(items[0]);
  const xfSec = numberFrom(xfInput, 0, 10);
  const lay = layout(items, rate, numberFrom(gapInput, 0, 60), xfSec);
  if (lay.total / rate > MAX_SECONDS * 1.05) {
    showError(`The joined result would be ${fmtTime(lay.total / rate)} long. The limit is about 2 hours because everything is held in memory; join fewer files at a time.`);
    return;
  }
  const name = outputName();
  busy = true;
  updateSummary();
  list.classList.add('is-busy');
  progressWrap.hidden = false;
  setProgress(0, 'Decoding…');
  const t0 = performance.now();
  try {
    let out;
    try {
      out = Array.from({ length: outCh }, () => new Float32Array(lay.total));
    } catch {
      throw new Error('Not enough memory for a result this long. Join fewer or shorter files at a time.');
    }
    const totalLen = lay.lens.reduce((a, b) => a + b, 0);
    let done = 0;
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      setProgress((done / totalLen) * 0.5, `Decoding ${i + 1} of ${items.length}…`);
      let buf;
      try {
        buf = await decodeAt(t.file, rate);
      } catch {
        t.status = 'error';
        t.error = 'Decoding failed while joining. Remove this file and try again.';
        render();
        throw new Error(`“${t.file.name}” could not be decoded. It is marked in the list.`);
      }
      const len = lay.lens[i];
      const off = lay.offsets[i];
      const head = lay.head[i];
      const tail = lay.tail[i];
      const n = Math.min(len, buf.length);
      const src = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      for (let c = 0; c < outCh; c++) {
        const s = src[Math.min(c, src.length - 1)]; // mono sources go to both channels
        const d = out[c];
        if (!head && !tail) { d.set(n === s.length ? s : s.subarray(0, n), off); continue; }
        for (let k = 0; k < n; k++) {
          let g = 1;
          if (k < head) g = k / head; // linear fade in under the previous clip's tail
          if (k >= len - tail) g *= (len - k) / tail; // linear fade out under the next clip's head
          d[off + k] += s[k] * g;
        }
      }
      buf = null; // free the decoded clip as soon as it is copied
      done += len;
    }
    setProgress(0.5, fmt === 'mp3' ? 'Encoding MP3…' : 'Writing WAV…');
    const label = fmt === 'mp3' ? 'Encoding MP3…' : 'Writing WAV…';
    const blob = await runWorker(out, rate, fmt, kbps, (v) => setProgress(0.5 + v * 0.5, label));
    out = null;
    setProgress(1, 'Done');
    showResult({ blob, name, seconds: lay.total / rate, rate, outCh, kbps, fmt, count: items.length, ms: performance.now() - t0 });
  } catch (err) {
    showError(err && err.message ? err.message : 'Joining failed.');
    progressWrap.hidden = true;
  } finally {
    busy = false;
    list.classList.remove('is-busy');
    updateSummary();
  }
}

function showResult({ blob, name, seconds, rate, outCh, kbps, fmt, count, ms }) {
  results.querySelector('.join-result')?.remove();
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'result join-result';
  card.dataset.seconds = seconds.toFixed(3);
  card.innerHTML = `
    <div class="result__meta">
      <div class="result__name"></div>
      <div class="result__info"></div>
    </div>
    <audio class="join-result__player" controls preload="metadata"></audio>
    <button class="btn btn--primary" id="download" type="button"></button>`;
  card.querySelector('.result__name').textContent = name;
  const kind = fmt === 'mp3' ? `MP3 ${kbps} kbps` : 'WAV 16-bit';
  card.querySelector('.result__info').textContent =
    `${fmtTime(seconds)} · ${formatBytes(blob.size)} · ${kind} · ${fmtRate(rate)} ${chanLabel(outCh)} · ${count} file${count > 1 ? 's' : ''} joined in ${(ms / 1000).toFixed(1)} s`;
  const player = card.querySelector('audio');
  player.src = playerUrl;
  player.setAttribute('aria-label', `Preview ${name}`);
  const dl = card.querySelector('#download');
  dl.textContent = `Download ${name}`;
  dl.addEventListener('click', () => downloadBlob(blob, name));
  results.append(card);
  card.scrollIntoView({ block: 'nearest' });
  toast(`Joined ${count} file${count > 1 ? 's' : ''} into ${name}`);
}

// ---------- events ----------
wireDropzone(zone, input, handleFiles);

// Files dropped anywhere else on the page are added too, instead of the browser opening them.
document.addEventListener('dragover', (e) => { if (!dragId && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (dragId) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) { e.preventDefault(); handleFiles(files); }
});

list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('li').dataset.id);
  if (btn.dataset.act === 'up') { move(id, -1); rowFor(id)?.querySelector('[data-act="up"]:not(:disabled)')?.focus(); }
  if (btn.dataset.act === 'down') { move(id, 1); rowFor(id)?.querySelector('[data-act="down"]:not(:disabled)')?.focus(); }
  if (btn.dataset.act === 'remove') removeTrack(id, true);
});

list.addEventListener('keydown', (e) => {
  const li = e.target;
  if (!(li instanceof HTMLLIElement)) return; // let the row's buttons behave normally
  const id = Number(li.dataset.id);
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(id, e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeTrack(id, true); }
  else if (e.key === 'Enter') { e.preventDefault(); join(); }
  else if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    (e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling)?.focus();
  }
});

// Drag handles: native drag and drop between rows (touch users get the arrow buttons).
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li');
  if (!li || busy) { e.preventDefault(); return; }
  dragId = Number(li.dataset.id);
  li.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.id);
});
list.addEventListener('dragover', (e) => {
  if (dragId == null) return;
  const li = e.target.closest('li');
  e.preventDefault();
  list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  if (!li || Number(li.dataset.id) === dragId) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
list.addEventListener('drop', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest('li');
  if (li && Number(li.dataset.id) !== dragId) {
    const after = li.classList.contains('drop-after');
    const from = tracks.findIndex((t) => t.id === dragId);
    const [moved] = tracks.splice(from, 1);
    let to = tracks.findIndex((t) => t.id === Number(li.dataset.id));
    if (after) to += 1;
    tracks.splice(to, 0, moved);
    render(dragId);
  }
});
list.addEventListener('dragend', () => {
  dragId = null;
  list.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('is-dragging', 'drop-before', 'drop-after'));
});

[gapInput, xfInput, formatSel, bitrateSel].forEach((el) => el.addEventListener('input', updateSummary));
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
joinBtn.addEventListener('click', join);
clearBtn.addEventListener('click', () => {
  if (busy) return;
  tracks = [];
  clearAlerts();
  results.querySelector('.join-result')?.remove();
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  progressWrap.hidden = true;
  render();
  zone.focus();
});
updateSummary();

// Called by the factory's screenshot script: three fictional generated clips, joined into an MP3.
window.__demo = async () => {
  const clips = ['intro-jingle.wav', 'episode-one.wav', 'outro-theme.wav'];
  const files = await Promise.all(clips.map(async (n) => {
    const blob = await (await fetch(`./tests/fixtures/${n}`)).blob();
    return new File([blob], n, { type: 'audio/wav' });
  }));
  await handleFiles(files);
  xfInput.value = '1';
  updateSummary();
  await join();
};

export { handleFiles };
