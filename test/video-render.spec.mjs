// Checks that video frames actually reach the screen.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto("test/audio-glitch.html");
  await page.waitForSelector("body[data-ready]");
});

// The video is drawn on a canvas that's controlled from an OffscreenCanvas,
// so we can't read its pixels from the page. Take screenshots instead.
function snapshot(page) {
  return page.locator("baby-video").screenshot();
}

test("renders video frames while playing", async ({ page }) => {
  const video = page.locator("baby-video");
  await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    video.currentTime = 1;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
  });
  // The video has its intrinsic size, and shows the frame at the seek target.
  const size = await video.evaluate((video) => [
    video.videoWidth,
    video.videoHeight
  ]);
  expect(size).not.toEqual([300, 150]);
  const first = await snapshot(page);
  await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
  const second = await snapshot(page);
  // Something moved.
  expect(second.equals(first)).toBe(false);
});
