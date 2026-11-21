// Checks that the element forgets the end of the stream when the
// MediaSource reopens for more media data.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/attributes.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
});

test("is no longer ended after appending more data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    await window.load();
    video.currentTime = video.duration;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    const endedBefore = video.ended;
    // Appending reopens the MediaSource, so more media data may follow.
    await window.run({ type: "append-media-again" });
    // In a worker, the element hears about it a bit later.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const endedAfterReopen = video.ended;
    // Ending the stream again ends playback again.
    await window.run({ type: "end-of-stream" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const endedAfterEndOfStream = video.ended;
    return { endedBefore, endedAfterReopen, endedAfterEndOfStream };
  });
  expect(result.endedBefore).toBe(true);
  expect(result.endedAfterReopen).toBe(false);
  expect(result.endedAfterEndOfStream).toBe(true);
});
