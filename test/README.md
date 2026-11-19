# Audio glitch test

Plays a pure 440 Hz sine wave (`fixtures/sine-440.m4a`, AAC-LC 48 kHz) through
`<baby-video>` forwards and backwards in headless Chromium, records what reaches
the audio destination, and checks that the result is still a clean sine wave.

For a pure sine, `x[n+1] - 2cos(w)x[n] + x[n-1]` is ~0 at every sample. Clicks,
dropped or duplicated samples, phase jumps and decoder garbage all show up as
spikes in that residual. Runs of digital silence are reported as gaps.

```sh
npx vite --port 5173 &
npm run test:audio
```

The fixtures were generated with:

```sh
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" -af "volume=0.5" \
  -c:a aac -b:a 192k -ac 2 -movflags frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 sine-440.m4a
ffmpeg -f lavfi -i "testsrc=size=320x180:rate=30:duration=10" -c:v libx264 -profile:v high \
  -pix_fmt yuv420p -g 30 -movflags frag_keyframe+empty_moov+default_base_moof video.m4v
```
