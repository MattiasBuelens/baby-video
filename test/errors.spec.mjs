// Checks the error attribute, the error event, networkState and load().
import { test, expect } from "@playwright/test";

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const NETWORK_EMPTY = 0;
const NETWORK_IDLE = 1;
const NETWORK_LOADING = 2;
const NETWORK_NO_SOURCE = 3;

const inWorker = () => test.info().project.metadata.query === "?worker";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto(
    `test/errors.html${test.info().project.metadata.query ?? ""}`
  );
  await page.waitForSelector("body[data-ready]");
  await page.evaluate(() => window.run({ type: "wait-for-open" }));
});

// Waits for the next error event, and returns a snapshot.
function waitForError(page) {
  return page.evaluate(async () => {
    if (!window.video.error) {
      await new Promise((resolve) =>
        window.video.addEventListener("error", resolve, { once: true })
      );
    }
    return window.snapshot();
  });
}

test("is loading after attaching", async ({ page }) => {
  const state = await page.evaluate(() => window.snapshot());
  expect(state.error).toBeNull();
  expect(state.networkState).toBe(NETWORK_LOADING);
  expect(state.events).toEqual(["loadstart"]);
  // The constants are on the element.
  const constants = await page.evaluate(() => [
    window.video.NETWORK_LOADING,
    window.video.constructor.NETWORK_NO_SOURCE,
    window.video.HAVE_ENOUGH_DATA
  ]);
  expect(constants).toEqual([2, 3, 4]);
});

for (const error of ["network", "decode"]) {
  test(`endOfStream("${error}") before metadata fails to load`, async ({
    page
  }) => {
    const play = page.evaluate(() =>
      window.video.play().then(
        () => "resolved",
        (e) => e.name
      )
    );
    await page.evaluate(
      (error) => window.run({ type: "end-of-stream", error }),
      error
    );
    const state = await waitForError(page);
    expect(state.error.code).toBe(MEDIA_ERR_SRC_NOT_SUPPORTED);
    expect(state.error.message).not.toBe("");
    expect(state.networkState).toBe(NETWORK_NO_SOURCE);
    expect(state.events).toEqual(["loadstart", "play", "error"]);
    // Pending play promises are rejected.
    expect(await play).toBe("NotSupportedError");
  });
}

test(`endOfStream("network") after metadata is a network error`, async ({
  page
}) => {
  await page.evaluate(() => window.run({ type: "append-media" }));
  await page.evaluate(() =>
    window.run({ type: "end-of-stream", error: "network" })
  );
  const state = await waitForError(page);
  expect(state.error.code).toBe(MEDIA_ERR_NETWORK);
  expect(state.networkState).toBe(NETWORK_IDLE);
  expect(state.readyState).toBeGreaterThan(0);
});

test(`endOfStream("decode") after metadata is a decode error`, async ({
  page
}) => {
  await page.evaluate(() => window.run({ type: "append-media" }));
  await page.evaluate(() =>
    window.run({ type: "end-of-stream", error: "decode" })
  );
  const state = await waitForError(page);
  expect(state.error.code).toBe(MEDIA_ERR_DECODE);
  expect(state.networkState).toBe(NETWORK_IDLE);
});

test("an append error is a decode error", async ({ page }) => {
  await page.evaluate(() => window.run({ type: "append-media" }));
  await page.evaluate(() => window.run({ type: "append-wrong-init-segment" }));
  const state = await waitForError(page);
  expect(state.error.code).toBe(MEDIA_ERR_DECODE);
});

test("an unsupported codec configuration fails to load", async ({ page }) => {
  // The initialization segment is rejected before the element gets metadata.
  await page.evaluate(() =>
    window.run({ type: "append-media", corruptVideoConfig: true })
  );
  const state = await waitForError(page);
  expect(state.error.code).toBe(MEDIA_ERR_SRC_NOT_SUPPORTED);
  expect(state.networkState).toBe(NETWORK_NO_SOURCE);
  expect(state.readyState).toBe(0);
});

test("a decoder error is a decode error", async ({ page }) => {
  await page.evaluate(() => window.run({ type: "append-media" }));
  await page.evaluate(() => window.run({ type: "fail-video-decoder" }));
  // Decode some more.
  await page.evaluate(() => {
    window.video.currentTime = 2;
  });
  const state = await waitForError(page);
  expect(state.error.code).toBe(MEDIA_ERR_DECODE);
  expect(state.error.message).toContain("VideoDecoder");
  expect(state.networkState).toBe(NETWORK_IDLE);
});

test("load() resets the element", async ({ page }) => {
  await page.evaluate(() => window.run({ type: "append-media" }));
  const result = await page.evaluate(async () => {
    const video = window.video;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A play() whose promise would be resolved by a pending task.
    const play = video.play().then(
      () => "resolved",
      (e) => e.name
    );
    window.clearEvents();
    const loadstart = new Promise((resolve) =>
      video.addEventListener("loadstart", resolve, { once: true })
    );
    video.load();
    const afterLoad = window.snapshot();
    await loadstart;
    return { afterLoad, play: await play, afterTask: window.snapshot() };
  });
  expect(result.afterLoad).toMatchObject({
    error: null,
    networkState: NETWORK_NO_SOURCE,
    readyState: 0,
    paused: true,
    currentTime: 0
  });
  expect(result.afterLoad.duration).toBeNaN();
  // The promise of a play() that was already playing would have been
  // resolved by a pending task, so it's resolved right away.
  expect(result.play).toBe("resolved");
  expect(result.afterTask.events).toEqual([
    "abort",
    "emptied",
    "timeupdate",
    "loadstart"
  ]);
  if (inWorker()) {
    // A handle can only be attached once, so loading it again fails.
    const state = await waitForError(page);
    expect(state.error.code).toBe(MEDIA_ERR_SRC_NOT_SUPPORTED);
  } else {
    // The MediaSource is closed, so it can be attached again.
    await page.evaluate(() => window.run({ type: "wait-for-open" }));
    const state = await page.evaluate(() => window.snapshot());
    expect(state.networkState).toBe(NETWORK_LOADING);
    expect(state.error).toBeNull();
  }
});

test("load() rejects pending play promises", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const video = window.video;
    const play = video.play().then(
      () => "resolved",
      (e) => e.name
    );
    window.clearEvents();
    const loadstart = new Promise((resolve) =>
      video.addEventListener("loadstart", resolve, { once: true })
    );
    video.load();
    await loadstart;
    return { play: await play, events: window.snapshot().events };
  });
  expect(result.play).toBe("AbortError");
  // The play event was queued before load(), so it's discarded.
  expect(result.events).toEqual(["abort", "emptied", "loadstart"]);
});

test("removing the source empties the element", async ({ page }) => {
  const state = await page.evaluate(async () => {
    window.clearEvents();
    window.video.srcObject = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return window.snapshot();
  });
  expect(state.networkState).toBe(NETWORK_EMPTY);
  expect(state.events).toEqual(["abort", "emptied"]);
});

test("attaching a MediaSource twice fails", async ({ page }) => {
  test.skip(inWorker(), "A handle is checked in handle.spec.mjs");
  const state = await page.evaluate(async () => {
    const otherVideo = window.otherVideo;
    window.attachToOtherVideo();
    await new Promise((resolve) =>
      otherVideo.addEventListener("error", resolve, { once: true })
    );
    return {
      code: otherVideo.error.code,
      networkState: otherVideo.networkState,
      buffered: otherVideo.buffered.length,
      // The first element is still fine.
      firstError: window.video.error
    };
  });
  expect(state).toEqual({
    code: MEDIA_ERR_SRC_NOT_SUPPORTED,
    networkState: NETWORK_NO_SOURCE,
    buffered: 0,
    firstError: null
  });
});
