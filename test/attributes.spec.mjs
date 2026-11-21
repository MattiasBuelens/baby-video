// Checks the content attributes: autoplay, loop, muted, poster,
// playsinline, width and height. Also defaultPlaybackRate, setting
// currentTime before loading, and event handler properties.
import { test, expect } from "@playwright/test";

// A 16x9 red rectangle.
const posterUrl =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="red"/></svg>'
  );

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/attributes.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
});

function waitForEvent(target, type) {
  return new Promise((resolve) =>
    target.addEventListener(type, resolve, { once: true })
  );
}

test("reflects content attributes", async ({ page }) => {
  const result = await page.evaluate(() => {
    const video = window.video;
    const before = {
      autoplay: video.autoplay,
      loop: video.loop,
      defaultMuted: video.defaultMuted,
      playsInline: video.playsInline,
      poster: video.poster,
      width: video.width
    };
    video.autoplay = true;
    video.loop = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.poster = "poster.png";
    video.width = 640;
    video.setAttribute("height", "  360px");
    return {
      before,
      attributes: video.getAttributeNames().sort(),
      poster: video.poster,
      width: video.getAttribute("width"),
      height: video.height,
      // The muted IDL attribute doesn't follow the content attribute.
      muted: video.muted
    };
  });
  expect(result.before).toEqual({
    autoplay: false,
    loop: false,
    defaultMuted: false,
    playsInline: false,
    poster: "",
    width: 0
  });
  expect(result.attributes).toEqual([
    "autoplay",
    "height",
    "loop",
    "muted",
    "playsinline",
    "poster",
    "width"
  ]);
  expect(result.poster).toMatch(/^http:.*\/test\/poster\.png$/);
  expect(result.width).toBe("640");
  expect(result.height).toBe(360);
  expect(result.muted).toBe(false);
});

test("the muted attribute mutes a new element", async ({ page }) => {
  const result = await page.evaluate(() => ({
    muted: window.mutedVideo.muted,
    defaultMuted: window.mutedVideo.defaultMuted,
    otherMuted: window.video.muted
  }));
  expect(result).toEqual({
    muted: true,
    defaultMuted: true,
    otherMuted: false
  });
});

test("width and height set the size", async ({ page }) => {
  const box = await page.locator("baby-video").nth(1).boundingBox();
  expect(box.width).toBe(320);
  expect(box.height).toBe(180);
  // Author styles still win.
  const styled = await page.evaluate(() => {
    window.mutedVideo.style.width = "200px";
    return window.mutedVideo.getBoundingClientRect().width;
  });
  expect(styled).toBe(200);
  // Changing or removing the attributes updates the size.
  const sizes = await page.evaluate(() => {
    const video = window.mutedVideo;
    video.style.width = "";
    video.width = 400;
    const changed = video.getBoundingClientRect().width;
    video.removeAttribute("width");
    const removed = video.getBoundingClientRect().width;
    return { changed, removed };
  });
  expect(sizes.changed).toBe(400);
  expect(sizes.removed).not.toBe(400);
});

test("event handler properties work", async ({ page }) => {
  const fired = await page.evaluate(async () => {
    const video = window.video;
    let fired = false;
    video.onloadedmetadata = () => {
      fired = true;
    };
    await window.load();
    if (video.readyState < 1) {
      await new Promise((resolve) =>
        video.addEventListener("loadedmetadata", resolve, { once: true })
      );
    }
    return fired;
  });
  expect(fired).toBe(true);
});

test("seeks to currentTime set before loading", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.currentTime = 2;
    const before = video.currentTime;
    const seeked = new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    await window.load();
    await seeked;
    return { before, after: video.currentTime, events: window.events };
  });
  expect(result.before).toBe(2);
  expect(result.after).toBe(2);
  expect(result.events).toEqual(["loadedmetadata", "seeking", "seeked"]);
});

test("load() resets playbackRate to defaultPlaybackRate", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.defaultPlaybackRate = 2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const playbackRateBefore = video.playbackRate;
    video.load();
    return {
      playbackRateBefore,
      playbackRate: video.playbackRate,
      defaultPlaybackRate: video.defaultPlaybackRate
    };
  });
  expect(result).toEqual({
    playbackRateBefore: 1,
    playbackRate: 2,
    defaultPlaybackRate: 2
  });
});

test("autoplay starts playing", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.autoplay = true;
    const playing = new Promise((resolve) =>
      video.addEventListener("playing", resolve, { once: true })
    );
    await window.load();
    await playing;
    return { paused: video.paused, events: window.events };
  });
  expect(result.paused).toBe(false);
  expect(result.events).toContain("play");
});

test("autoplay doesn't start after pause()", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.autoplay = true;
    await window.attach();
    // Loading resets the can autoplay flag, so pause after that.
    video.pause();
    await window.append();
    while (video.readyState < 4) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { paused: video.paused, events: window.events };
  });
  expect(result.paused).toBe(true);
  expect(result.events).not.toContain("play");
});

test("loop seeks back to the start", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.loop = true;
    await window.load();
    video.currentTime = video.duration - 0.5;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    window.events.length = 0;
    await video.play();
    // Wait for the seek back to the start.
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended,
      events: window.events
    };
  });
  expect(result.currentTime).toBeLessThan(1);
  expect(result.paused).toBe(false);
  expect(result.ended).toBe(false);
  expect(result.events).not.toContain("ended");
  expect(result.events).not.toContain("pause");
});

test("loop seeks back to the end when playing backwards", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    video.loop = true;
    await window.load();
    video.playbackRate = -1;
    video.currentTime = 0.5;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    await video.play();
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused
    };
  });
  expect(result.currentTime).toBeGreaterThan(result.duration - 1);
  expect(result.paused).toBe(false);
});

test("shows the poster until playback starts", async ({ page }) => {
  await page.evaluate((posterUrl) => {
    window.video.poster = posterUrl;
  }, posterUrl);
  await expect
    .poll(() => page.evaluate(() => window.isPosterShown()))
    .toBe(true);
  // Still shown once loaded, since we're paused at the first frame.
  await page.evaluate(() => window.load());
  expect(await page.evaluate(() => window.isPosterShown())).toBe(true);
  // Hidden once playing.
  await page.evaluate(() => window.video.play());
  expect(await page.evaluate(() => window.isPosterShown())).toBe(false);
  // Not shown again after pausing.
  await page.evaluate(() => window.video.pause());
  expect(await page.evaluate(() => window.isPosterShown())).toBe(false);
  // But shown again after loading a new source.
  await page.evaluate(() => window.video.load());
  expect(await page.evaluate(() => window.isPosterShown())).toBe(true);
});
