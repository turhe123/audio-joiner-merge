// worker.js — encodes the joined PCM into MP3 (lamejs) or 16-bit WAV, off the main thread.
// In:  { channels: Float32Array[], sampleRate, format: 'mp3' | 'wav', kbps }
// Out: { type: 'progress', value: 0..1 } … then { type: 'done', blob } or { type: 'error', message }
/* global lamejs */
importScripts('vendor/lamejs/lame.min.js');

const BLOCK = 1152; // one MPEG-1 Layer III frame worth of samples

function toInt16(src, start, end, dst) {
  for (let i = start, j = 0; i < end; i++, j++) {
    let s = src[i];
    if (s > 1) s = 1; else if (s < -1) s = -1; // clamp after mixing crossfades
    dst[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
}

function encodeMp3(channels, sampleRate, kbps) {
  const n = channels.length;
  const total = channels[0].length;
  const enc = new lamejs.Mp3Encoder(n, sampleRate, kbps);
  const left = new Int16Array(BLOCK);
  const right = new Int16Array(BLOCK);
  const parts = [];
  let lastReport = 0;
  for (let pos = 0; pos < total; pos += BLOCK) {
    const end = Math.min(pos + BLOCK, total);
    const len = end - pos;
    const l = len === BLOCK ? left : left.subarray(0, len);
    toInt16(channels[0], pos, end, l);
    let buf;
    if (n === 2) {
      const r = len === BLOCK ? right : right.subarray(0, len);
      toInt16(channels[1], pos, end, r);
      buf = enc.encodeBuffer(l, r);
    } else {
      buf = enc.encodeBuffer(l);
    }
    if (buf.length) parts.push(buf);
    if (end - lastReport > sampleRate * 2) { lastReport = end; postMessage({ type: 'progress', value: end / total }); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  return new Blob(parts, { type: 'audio/mpeg' });
}

function encodeWav(channels, sampleRate) {
  const n = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * n * 2, true); v.setUint16(32, n * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  const out = new Int16Array(buf, 44);
  const step = sampleRate * 10;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      let s = channels[c][i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i * n + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (i % step === 0 && i) postMessage({ type: 'progress', value: i / frames });
  }
  return new Blob([buf], { type: 'audio/wav' });
}

self.onmessage = (e) => {
  const { channels, sampleRate, format, kbps } = e.data;
  try {
    const blob = format === 'wav' ? encodeWav(channels, sampleRate) : encodeMp3(channels, sampleRate, kbps);
    postMessage({ type: 'progress', value: 1 });
    postMessage({ type: 'done', blob });
  } catch (err) {
    postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
