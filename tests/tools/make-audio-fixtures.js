// Generates the small, fictional demo clips used by __demo and tests/smoke.spec.js.
//   node tests/tools/make-audio-fixtures.js
// Each clip is a plain tone with a different pitch, rate and channel count, so the joined order can be heard
// and the joiner has to resample and upmix.
const fs = require('fs');
const path = require('path');

function wav({ seconds, rate, channels, freqs }) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  const fade = Math.round(0.02 * rate);
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / fade, (frames - 1 - i) / fade);
    for (let c = 0; c < channels; c++) {
      const f = freqs[c % freqs.length];
      const s = 0.35 * env * Math.sin((2 * Math.PI * f * i) / rate);
      data.writeInt16LE(Math.round(s * 32767), (i * channels + c) * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const out = path.join(__dirname, '..', 'fixtures');
fs.writeFileSync(path.join(out, 'intro-jingle.wav'), wav({ seconds: 3, rate: 44100, channels: 1, freqs: [523.25] }));
fs.writeFileSync(path.join(out, 'episode-one.wav'), wav({ seconds: 6, rate: 22050, channels: 1, freqs: [329.63] }));
fs.writeFileSync(path.join(out, 'outro-theme.wav'), wav({ seconds: 3, rate: 32000, channels: 2, freqs: [783.99, 659.25] }));
console.log('wrote intro-jingle.wav, episode-one.wav, outro-theme.wav');
