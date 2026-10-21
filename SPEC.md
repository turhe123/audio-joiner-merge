# Audio Joiner and Merger — specification

**Tagline:** Join several audio files into one MP3 or WAV in your browser with drag to reorder and crossfade.

**Category:** Audio & Video

**Free alternative to:** Audio Joiner at 123apps (ad supported, uploads files for processing on some flows, limits on formats and sizes, nags for the paid app)

**Search phrases:** audio joiner, merge audio files, combine mp3 files, join mp3 online, merge mp3, concatenate audio, combine audio files free

**Allowed libraries:** lamejs

**Published at:** https://turhe123.github.io/audio-joiner-merge/

## Acceptance checks (each must have a test)

- Dropping three sample audio files lists them in order with durations
- Reordering the first and last file changes the order in the summary
- Pressing Join downloads one MP3 whose duration is about the sum of the parts
- A crossfade of 2 seconds makes the total shorter by about 2 seconds per join
- A non audio file is rejected with a message
- Works at 390px wide

## Spec

Combining audio files is a common job: stitching podcast intro and episode, joining recorded voice memo parts, building a mixtape or merging audiobook chapters. People search for audio joiner, merge mp3 files and combine audio files. The best known sites are free but heavy with ads, push users toward apps, and some flows upload the files. Our version joins local files and saves one result, which is a single clear job.

Feature set: add multiple audio files by drop or picker. Show them in a list with name, duration and size. Reorder by drag handles and up and down buttons, remove a row, and add a silent gap between files (default 0 seconds). An optional crossfade between consecutive files (default 0 seconds, up to 10). Output format MP3 (default, bitrate 192 kbps with choices) or WAV. Output sample rate follows the first file, and other files are resampled. Show total duration before joining. Output name is joined by default and can be edited.

UI: drop zone first, then the ordered list, then options in one row, then a primary Join button. Progress shows percentage. The result card shows the final duration, size, an audio player and Download. Empty state explains the privacy. Errors appear on the row that failed to decode. Keyboard: with a row focused, alt plus up or down moves it, Delete removes it, Enter joins.

Technical approach: decode each file with decodeAudioData, in order, and resample to the target rate using an OfflineAudioContext only when rates differ. Compute the output length from the durations, gaps and crossfades, allocate Float32 arrays per channel, copy each buffer at its offset, and for crossfades apply linear gain ramps to the overlapping tails and heads. Mix mono sources into both channels. Then encode with lamejs in a Web Worker in blocks of 1152 samples, or write a PCM WAV by hand. Free decoded buffers as soon as they are copied. Download through an object URL which is revoked later. A total decoded length of about two hours is the ceiling stated in the interface, because of memory.

Edge cases: files with different channel counts or sample rates, extremely different loudness (mention that no normalization is done), long files that exceed memory, Safari needing a user gesture to create the audio context, files that browsers cannot decode (some M4A or FLAC), duplicate file names, and Unicode in names. Clipping is prevented by clamping after mixing the crossfade regions.

Demo data: three bundled generated clips called Intro Jingle, Episode One and Outro Theme, of three, six and three seconds, each with a different tone, so the order of the joined result can be heard.
