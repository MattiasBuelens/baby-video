import "media-chrome";
import { BabyMediaSource, BabyVideoElement } from "../src/index";

const video = document.querySelector<BabyVideoElement>("baby-video")!;
video.addEventListener("loadedmetadata", logEvent);
video.addEventListener("loadeddata", logEvent);
video.addEventListener("canplay", logEvent);
video.addEventListener("canplaythrough", logEvent);
video.addEventListener("waiting", logEvent);
video.addEventListener("play", logEvent);
video.addEventListener("pause", logEvent);
video.addEventListener("playing", logEvent);
video.addEventListener("timeupdate", logEvent);
video.addEventListener("durationchange", logEvent);
video.addEventListener("seeking", logEvent);
video.addEventListener("seeked", logEvent);
video.addEventListener("progress", logEvent);
video.addEventListener("resize", logEvent);

const mediaSource = new BabyMediaSource();
video.srcObject = mediaSource;
if (mediaSource.readyState !== "open") {
  await waitForEvent(mediaSource, "sourceopen");
}
mediaSource.duration = 60;
const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4`);
const segmentURLs = [
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_0.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_1.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_2.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_0.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_2.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_3.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_4.m4v",
];
for (const segmentURL of segmentURLs) {
  const segmentData = await (await fetch(segmentURL)).arrayBuffer();
  sourceBuffer.appendBuffer(segmentData);
  await waitForEvent(sourceBuffer, "updateend");
}

function waitForEvent(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });
}

function logEvent(event: Event) {
  console.log(`${event.type} @ ${video.currentTime}`);
}
