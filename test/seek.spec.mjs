// Checks seeking while the media data for the new position trickles in.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/attributes.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
});

test("completes a seek when one track arrives before the other", async ({
  page
}) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    await window.attach();
    await window.run({ type: "append-media" });
    // Only the video is buffered at the seek target, so there's no media data
    // for the new position yet...
    await window.run({ type: "remove", track: "audio", start: 4, end: 11 });
    const seeked = new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    video.currentTime = 6;
    // ...but the pipeline can already decode (and show) the video frame
    // at the seek target.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const seekingBefore = video.seeking;
    // Then the audio arrives.
    await window.run({ type: "append-media-again", track: "audio" });
    const timedOut = await Promise.race([
      seeked.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 2000))
    ]);
    return {
      seekingBefore,
      timedOut,
      seeking: video.seeking,
      currentTime: video.currentTime
    };
  });
  expect(result.seekingBefore).toBe(true);
  expect(result.timedOut).toBe(false);
  expect(result.seeking).toBe(false);
  expect(result.currentTime).toBe(6);
});
