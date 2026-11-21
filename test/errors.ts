// Test page for media errors and the load algorithm,
// driven by test/errors.spec.mjs.
import type { BabyVideoElement } from "../src/index";
import { attachSource } from "./attach-source";

const [video, otherVideo] =
  document.querySelectorAll<BabyVideoElement>("baby-video");

const events: string[] = [];
for (const type of [
  "loadstart",
  "abort",
  "emptied",
  "error",
  "loadedmetadata",
  "loadeddata",
  "play",
  "playing",
  "pause",
  "timeupdate"
]) {
  video.addEventListener(type, () => events.push(type));
}

const { run, mediaSource } = await attachSource(video);

function snapshot() {
  return {
    error: video.error && {
      code: video.error.code,
      message: video.error.message
    },
    networkState: video.networkState,
    readyState: video.readyState,
    paused: video.paused,
    currentTime: video.currentTime,
    duration: video.duration,
    events: [...events]
  };
}

declare global {
  interface Window {
    run: typeof run;
    snapshot: typeof snapshot;
    clearEvents(): void;
    video: BabyVideoElement;
    otherVideo: BabyVideoElement;
    // Only on the main thread.
    attachToOtherVideo(): void;
  }
}
window.run = run;
window.snapshot = snapshot;
window.clearEvents = () => {
  events.length = 0;
};
window.attachToOtherVideo = () => {
  otherVideo.srcObject = mediaSource!;
};
window.video = video;
window.otherVideo = otherVideo;
document.body.dataset.ready = "true";
