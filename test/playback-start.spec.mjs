// Checks what happens around the start of the media in reverse playback:
// seeking to 0, reaching 0 while playing, and calling play() at 0.
import { test, expect } from "@playwright/test";

// Page-side helpers, installed once per page.
function install() {
  const video = document.querySelector("baby-video");
  window.events = [];
  for (const type of [
    "waiting",
    "play",
    "playing",
    "pause",
    "ended",
    "seeking",
    "seeked",
    "ratechange"
  ]) {
    video.addEventListener(type, () => window.events.push(type));
  }
  window.seek = async (time, playbackRate) => {
    video.pause();
    video.playbackRate = playbackRate;
    video.currentTime = time;
    if (video.seeking) {
      await new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true })
      );
    }
    window.events.length = 0;
  };
  window.state = () => ({
    currentTime: video.currentTime,
    paused: video.paused,
    ended: video.ended,
    seeking: video.seeking,
    playbackRate: video.playbackRate,
    duration: video.duration,
    events: [...window.events]
  });
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/audio-glitch.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
  await page.evaluate(install);
});

test("forward seek to 0", async ({ page }) => {
  const state = await page.evaluate(async () => {
    await window.seek(0, 1);
    return window.state();
  });
  expect(state.currentTime).toBe(0);
});

test("reverse seek to 0", async ({ page }) => {
  const state = await page.evaluate(async () => {
    await window.seek(0, -1);
    return window.state();
  });
  expect(state.currentTime).toBe(0);
});

test("reverse playback pauses at the start, without ended", async ({
  page
}) => {
  const state = await page.evaluate(async () => {
    await window.seek(0.5, -1);
    await document.querySelector("baby-video").play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return window.state();
  });
  expect(state).toMatchObject({ currentTime: 0, paused: true, ended: false });
  expect(state.events).toContain("pause");
  expect(state.events).not.toContain("ended");
});

test("play() at the start in reverse restarts from the end", async ({
  page
}) => {
  const state = await page.evaluate(async () => {
    // Play backwards until playback pauses at the start.
    await window.seek(0.5, -1);
    const video = document.querySelector("baby-video");
    await video.play();
    if (!video.paused) {
      await new Promise((resolve) =>
        video.addEventListener("pause", resolve, { once: true })
      );
    }
    window.events.length = 0;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return window.state();
  });
  // Restarted from the end, keeping the rate, and actually playing backwards.
  expect(state).toMatchObject({ paused: false, playbackRate: -1 });
  expect(state.currentTime).toBeGreaterThan(state.duration - 2);
  expect(state.currentTime).toBeLessThan(state.duration - 1);
  expect(state.events).not.toContain("ratechange");
});
