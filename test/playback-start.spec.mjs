// Checks what happens around the start of the media in reverse playback:
// seeking to 0, reaching 0 while playing, and calling play() at 0.
//
// Usage: npx vite --port 5173 &  node test/playback-start.spec.mjs
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173/baby-video/";

// Runs `fn` in the page, with a timeout so a hang fails the test.
async function run(page, name, fn, arg, timeout = 10000) {
  try {
    const result = await Promise.race([
      page.evaluate(fn, arg),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), timeout)
      )
    ]);
    return result;
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    await page.reload();
    await page.waitForSelector("body[data-ready]", { timeout: 15000 });
    return undefined;
  }
}

function check(name, condition, details) {
  console.log(
    `${condition ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(details)}`
  );
  return condition;
}

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

async function main() {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error("[page]", err));
  const open = async () => {
    await page.goto(new URL("test/audio-glitch.html", baseUrl).href);
    await page.waitForSelector("body[data-ready]", { timeout: 15000 });
    await page.evaluate(install);
  };
  let ok = true;

  // Forward seek to 0, as a baseline.
  await open();
  let state = await run(page, "forward seek to 0", async () => {
    await window.seek(0, 1);
    return window.state();
  });
  ok =
    state !== undefined &&
    check("forward seek to 0", state.currentTime === 0, state) &&
    ok;

  // Reverse seek to 0.
  await open();
  state = await run(page, "reverse seek to 0", async () => {
    await window.seek(0, -1);
    return window.state();
  });
  ok =
    state !== undefined &&
    check("reverse seek to 0", state.currentTime === 0, state) &&
    ok;

  // Reverse playback reaching the start: pauses, without ended.
  await open();
  state = await run(page, "reverse playback reaches start", async () => {
    await window.seek(0.5, -1);
    await document.querySelector("baby-video").play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return window.state();
  });
  ok =
    state !== undefined &&
    check(
      "reverse playback reaches start",
      state.currentTime === 0 &&
        state.paused &&
        state.events.includes("pause") &&
        !state.events.includes("ended"),
      state
    ) &&
    ok;

  // play() at the start in reverse: restarts from the end, keeping the rate.
  state = await run(page, "play() at start in reverse", async () => {
    const video = document.querySelector("baby-video");
    window.events.length = 0;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return window.state();
  });
  ok =
    state !== undefined &&
    check(
      "play() at start in reverse",
      !state.paused &&
        state.playbackRate === -1 &&
        // Restarted from the end, and actually playing backwards from there.
        state.currentTime > state.duration - 2 &&
        state.currentTime < state.duration - 1 &&
        !state.events.includes("ratechange"),
      state
    ) &&
    ok;

  await browser.close();
  process.exitCode = ok ? 0 : 1;
}

await main();
