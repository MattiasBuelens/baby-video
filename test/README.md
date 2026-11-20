# Audio glitch test

Plays a pure 440 Hz sine wave (`fixtures/sine-440.m4a`, AAC-LC 48 kHz) through
`<baby-video>` forwards and backwards in headless Chromium, records what reaches
the audio destination, and checks that the result is still a clean sine wave.

For a pure sine, `x[n+1] - 2cos(w)x[n] + x[n-1]` is ~0 at every sample. Clicks,
dropped or duplicated samples, phase jumps and decoder garbage all show up as
spikes in that residual. Runs of digital silence are reported as gaps.

```sh
npx playwright install chromium  # once
npm test                         # all tests
npm run test:audio               # only this test
```

Playwright starts the vite dev server on port 5173 by itself (or reuses one
that's already running). On failure, a trace is saved in `test-results/`;
open it with `npx playwright show-trace <path>`.

# Playback start test

`npm run test:playback` checks reverse playback around the start of the media:
seeking to 0, playing backwards until 0 (which pauses, without `ended`), and
calling `play()` there (which restarts from the end, keeping the playback rate).
It uses the same test page and fixtures.

The fixtures were generated with:

```sh
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" -af "volume=0.5" \
  -c:a aac -b:a 192k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 sine-440.m4a
# Negative composition offsets make the first video frame start at 0 (instead of
# after the B-frame reordering delay), since we don't apply edit lists.
ffmpeg -f lavfi -i "testsrc=size=320x180:rate=30:duration=10" -c:v libx264 -profile:v high \
  -pix_fmt yuv420p -g 30 -avoid_negative_ts disabled -use_editlist 0 \
  -movflags frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets video.m4v
```
