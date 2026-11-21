// Checks requestVideoFrameCallback() and getVideoPlaybackQuality().
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/audio-glitch.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
});

test("fires a video frame callback for the frame after a seek", async ({
  page
}) => {
  const metadata = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    const nextFrame = () =>
      new Promise((resolve) =>
        video.requestVideoFrameCallback((now, metadata) =>
          resolve({ now, metadata })
        )
      );
    // The first frame was presented before we asked, so the first callback
    // gets that one.
    const first = await nextFrame();
    if (first.metadata.mediaTime !== 0) {
      throw new Error(
        `Expected the first frame, got ${first.metadata.mediaTime}`
      );
    }
    const frame = nextFrame();
    video.currentTime = 1;
    return frame;
  });
  // The frame at the seek target, with the size of the video.
  expect(metadata.metadata.mediaTime).toBeLessThanOrEqual(1);
  expect(metadata.metadata.mediaTime).toBeGreaterThan(0.9);
  expect(metadata.metadata.width).toBeGreaterThan(0);
  expect(metadata.metadata.height).toBeGreaterThan(0);
  expect(metadata.metadata.presentedFrames).toBeGreaterThan(0);
  expect(metadata.metadata.processingDuration).toBeGreaterThanOrEqual(0);
  // The times are on the page's own clock, even with the pipeline in a worker.
  expect(metadata.metadata.presentationTime).toBeGreaterThan(0);
  expect(metadata.metadata.presentationTime).toBeLessThanOrEqual(
    metadata.now + 100
  );
  expect(metadata.metadata.expectedDisplayTime).toBeGreaterThan(
    metadata.metadata.presentationTime - 100
  );
});

test("fires video frame callbacks for new frames while playing", async ({
  page
}) => {
  const result = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    const frames = [];
    let canceledRan = false;
    const onFrame = (now, metadata) => {
      frames.push(metadata);
      if (frames.length < 10) {
        video.requestVideoFrameCallback(onFrame);
      }
    };
    video.requestVideoFrameCallback(onFrame);
    const handle = video.requestVideoFrameCallback(() => {
      canceledRan = true;
    });
    video.cancelVideoFrameCallback(handle);
    await video.play();
    while (frames.length < 10) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    video.pause();
    return { frames, canceledRan };
  });
  expect(result.canceledRan).toBe(false);
  const { frames } = result;
  for (let i = 1; i < frames.length; i++) {
    // Each callback sees a new frame, later in the media.
    expect(frames[i].presentedFrames).toBeGreaterThan(
      frames[i - 1].presentedFrames
    );
    expect(frames[i].mediaTime).toBeGreaterThan(frames[i - 1].mediaTime);
  }
});

test("counts presented and dropped frames", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    const before = video.getVideoPlaybackQuality();
    // Each new frame that's presented counts.
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    video.pause();
    const after = video.getVideoPlaybackQuality();
    return {
      before: {
        totalVideoFrames: before.totalVideoFrames,
        droppedVideoFrames: before.droppedVideoFrames,
        creationTime: before.creationTime
      },
      after: {
        totalVideoFrames: after.totalVideoFrames,
        droppedVideoFrames: after.droppedVideoFrames,
        corruptedVideoFrames: after.corruptedVideoFrames,
        creationTime: after.creationTime
      }
    };
  });
  // A second of video at 24 to 60 fps.
  expect(
    result.after.totalVideoFrames - result.before.totalVideoFrames
  ).toBeGreaterThan(15);
  expect(result.after.droppedVideoFrames).toBeLessThanOrEqual(
    result.after.totalVideoFrames
  );
  expect(result.after.corruptedVideoFrames).toBe(0);
  expect(result.after.creationTime).toBeGreaterThan(result.before.creationTime);
});

test("counts frames that miss their deadline as dropped", async ({ page }) => {
  const quality = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Block the main thread. The pipeline on the main thread can't render
    // in the meantime, so it has to drop the frames it missed.
    const end = performance.now() + 500;
    while (performance.now() < end) {}
    await new Promise((resolve) => setTimeout(resolve, 500));
    video.pause();
    const quality = video.getVideoPlaybackQuality();
    return {
      totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames
    };
  });
  expect(quality.droppedVideoFrames).toBeLessThanOrEqual(
    quality.totalVideoFrames
  );
  // In a worker, the pipeline could keep rendering while the main thread is
  // busy, but headless Chromium only gives the worker animation frames when
  // the main thread renders. So it drops frames too, but we can't rely on it.
  if (test.info().project.metadata.query !== "?worker") {
    expect(quality.droppedVideoFrames).toBeGreaterThan(5);
  }
});

test("does not count frames before a seek target as dropped", async ({
  page
}) => {
  const quality = await page.evaluate(async () => {
    const video = document.querySelector("baby-video");
    const nextFrame = () =>
      new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    // Wait for the first frame.
    await nextFrame();
    // Somewhere in the middle of a GOP, so the frames from the key frame
    // to the target have to be decoded first.
    for (const time of [1.5, 2.7, 3.3]) {
      const frame = nextFrame();
      video.currentTime = time;
      await frame;
    }
    const quality = video.getVideoPlaybackQuality();
    return {
      totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames
    };
  });
  expect(quality.droppedVideoFrames).toBe(0);
  // The first frame, and one for each seek.
  expect(quality.totalVideoFrames).toBe(4);
});
