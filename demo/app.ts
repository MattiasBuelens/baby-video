import "media-chrome";
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { waitForEvent } from "../src/util";

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

const streamDuration = 643.56;

const mediaSource = new BabyMediaSource();
video.srcObject = mediaSource;
if (mediaSource.readyState !== "open") {
  await waitForEvent(mediaSource, "sourceopen");
}
mediaSource.duration = streamDuration;
const sourceBuffer = mediaSource.addSourceBuffer(
  'video/mp4; codecs="avc1.640028"'
);
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

interface Segment {
  url: string;
  isLast: boolean;
}

const segmentDuration = 4;

function getSegmentForTime(time: number): Segment | undefined {
  const segmentIndex = 1 + Math.floor(time / segmentDuration);
  if (segmentIndex < 0) {
    return undefined;
  }
  return {
    url: `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_${segmentIndex}.m4v`,
    isLast: segmentIndex === 159,
  };
}

let pendingBufferLoop: Promise<void> = Promise.resolve();

async function bufferLoop(signal: AbortSignal) {
  await pendingBufferLoop;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const currentTime = video.currentTime;
    const currentRange = video.buffered.find(currentTime);
    const targetTime = currentRange ? currentRange[1] : currentTime;
    if (targetTime - currentTime < 20) {
      const segment = getSegmentForTime(targetTime);
      if (segment) {
        const segmentData = await (
          await fetch(segment.url, { signal })
        ).arrayBuffer();
        sourceBuffer.appendBuffer(segmentData);
        await waitForEvent(sourceBuffer, "updateend");
        if (segment.isLast) {
          mediaSource.endOfStream();
          break; // stop buffering until next seek
        }
        continue;
      }
    }
    await waitForEvent(video, "timeupdate", signal);
  }
}

let bufferAbortController: AbortController = new AbortController();

function restartBuffering() {
  bufferAbortController.abort();
  bufferAbortController = new AbortController();
  pendingBufferLoop = bufferLoop(bufferAbortController.signal).catch(() => {});
}

video.addEventListener("seeking", restartBuffering);
restartBuffering();

function logEvent(event: Event) {
  console.log(`${event.type} @ ${video.currentTime}`);
}
