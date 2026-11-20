// Detects gaps and crackles in the audio output of <baby-video>.
//
// The fixture is a pure 440 Hz sine wave (AAC-LC, 48 kHz). We play it through
// the element (forwards and backwards), record what reaches the audio
// destination, and check that the recording is still a clean sine wave.
//
// A pure sine satisfies x[n+1] = 2cos(w)x[n] - x[n-1] exactly, so the residual
// x[n+1] - 2cos(w)x[n] + x[n-1] is ~0 everywhere, except at clicks, dropped or
// duplicated samples, phase jumps or garbage from the decoder.
// Reversing a sine wave gives a sine wave again, so the same check works for
// reverse playback.
import { test, expect } from "@playwright/test";

const frequency = 440;
// Residual above which we count a sample as a glitch. For a 0.5 amplitude sine
// at 48 kHz, AAC coding noise stays well below this, while a single missing
// AAC frame (1024 samples) causes a phase jump with a residual of ~0.1-0.5.
const glitchThreshold = 0.02;
// Shortest run of digital silence, in the middle of playback, that counts as a gap.
const minGapSamples = 16;

function analyze(samples, sampleRate) {
  // Trim silence before playback starts and after it stops.
  let first = samples.findIndex((x) => Math.abs(x) > 1e-3);
  let last = samples.findLastIndex((x) => Math.abs(x) > 1e-3);
  if (first < 0) return { activeSamples: 0, glitches: [], gaps: [] };
  // Skip the fade-in region of the first and last few ms.
  first += Math.round(sampleRate * 0.05);
  last -= Math.round(sampleRate * 0.05);
  const c = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  const glitches = [];
  for (let n = first + 1; n < last - 1; n++) {
    const r = samples[n + 1] - c * samples[n] + samples[n - 1];
    if (Math.abs(r) > glitchThreshold) {
      const time = n / sampleRate;
      const prev = glitches[glitches.length - 1];
      // Merge glitches within 5ms into one event.
      if (prev && time - prev.end < 0.005) {
        prev.end = time;
        prev.peak = Math.max(prev.peak, Math.abs(r));
      } else {
        glitches.push({ start: time, end: time, peak: Math.abs(r) });
      }
    }
  }
  const gaps = [];
  let run = 0;
  for (let n = first; n < last; n++) {
    if (samples[n] === 0) {
      run++;
    } else {
      if (run >= minGapSamples)
        gaps.push({ at: (n - run) / sampleRate, samples: run });
      run = 0;
    }
  }
  return { activeSamples: last - first, glitches, gaps };
}

const cases = [
  { name: "forward", start: 1, playbackRate: 1, seconds: 4 },
  { name: "reverse", start: 8.51, playbackRate: -1, seconds: 4 },
  // Seeking exactly to a frame boundary (of both the 30fps video and the
  // 1024-sample audio frames at 48kHz: 8 = 250 * 1024 / 48000).
  {
    name: "reverse from frame boundary",
    start: 8,
    playbackRate: -1,
    seconds: 2
  }
];

for (const testCase of cases) {
  test(`no glitches or gaps: ${testCase.name}`, async ({ page }) => {
    test.setTimeout((testCase.seconds + 20) * 1000);
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[page]", msg.text());
    });
    page.on("pageerror", (err) => console.error("[page]", err));
    await page.goto("test/audio-glitch.html");
    await page.waitForSelector("body[data-ready]");

    const { samples, sampleRate } = await page.evaluate(
      (options) => window.recordPlayback(options),
      testCase
    );
    const { activeSamples, glitches, gaps } = analyze(samples, sampleRate);
    const summary = {
      seconds: Number((activeSamples / sampleRate).toFixed(2)),
      glitches: glitches.slice(0, 15).map((g) => ({
        start: Number(g.start.toFixed(4)),
        end: Number(g.end.toFixed(4)),
        peak: Number(g.peak.toFixed(3))
      })),
      gaps: gaps.slice(0, 10).map((g) => ({
        at: Number(g.at.toFixed(4)),
        samples: g.samples
      }))
    };
    expect(activeSamples, "recorded at least 1s of audio").toBeGreaterThan(
      sampleRate
    );
    expect(summary.glitches, "glitches").toEqual([]);
    expect(summary.gaps, "gaps").toEqual([]);
  });
}
