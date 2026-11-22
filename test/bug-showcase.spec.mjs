// Checks the bugs that <baby-video> can show on purpose, for the demo.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/audio-glitch.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
});

test("bugDecodeVideoInReverse can be turned on and off while playing backwards", async ({
  page
}) => {
  const result = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    video.currentTime = video.duration - 0.5;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    video.bugDecodeVideoInReverse = true;
    video.playbackRate = -1;
    await video.play();
    await sleep(1000);
    // Depending on the decoder, the bug shows garbage or stalls the video,
    // but it never puts the element in an error state.
    const errorWithBug = video.error?.message ?? null;
    video.bugDecodeVideoInReverse = false;
    const before = video.getVideoPlaybackQuality().totalVideoFrames;
    await sleep(1000);
    const after = video.getVideoPlaybackQuality().totalVideoFrames;
    video.pause();
    return {
      errorWithBug,
      error: video.error?.message ?? null,
      paused: video.paused,
      framesAfterFix: after - before
    };
  });
  expect(result.errorWithBug).toBeNull();
  expect(result.error).toBeNull();
  // Turning the bug off brings the video back: a second at 24 to 60 fps.
  expect(result.framesAfterFix).toBeGreaterThan(15);
});
