import "media-chrome";
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { TimeRanges } from "../src/time-ranges";
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

const streamDuration = 634.56;

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
  startTime: number;
  isLast: boolean;
}

const segmentDuration = 4;
const lastSegmentIndex = Math.ceil(streamDuration / segmentDuration) - 1;

function getSegmentForTime(time: number): Segment | undefined {
  const segmentIndex = Math.min(
    lastSegmentIndex,
    Math.floor(time / segmentDuration)
  );
  if (segmentIndex < 0) {
    return undefined;
  }
  const url = `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_${
    segmentIndex + 1
  }.m4v`;
  return {
    url,
    startTime: segmentIndex * segmentDuration,
    isLast: segmentIndex === lastSegmentIndex,
  };
}

let pendingBufferLoop: Promise<void> = Promise.resolve();

async function bufferLoop(signal: AbortSignal) {
  await pendingBufferLoop;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const currentRange = video.buffered.find(video.currentTime);
    const nextTime = currentRange ? currentRange[1] : video.currentTime;
    const nextSegment = getSegmentForTime(nextTime)!;
    // Wait for current time to reach end of its buffer
    while (nextSegment.startTime - video.currentTime > 20) {
      await waitForEvent(video, "timeupdate", signal);
    }
    // Remove old buffer before/after current time
    const oldBuffered = video.buffered.subtract(
      new TimeRanges([[video.currentTime - 10, video.currentTime + 30]])
    );
    for (let i = 0; i < oldBuffered.length; i++) {
      sourceBuffer.remove(oldBuffered.start(i), oldBuffered.end(i));
      await waitForEvent(sourceBuffer, "updateend");
    }
    // Append next segment
    const segmentData = await (
      await fetch(nextSegment.url, { signal })
    ).arrayBuffer();
    sourceBuffer.appendBuffer(segmentData);
    await waitForEvent(sourceBuffer, "updateend");
    if (nextSegment.isLast) {
      mediaSource.endOfStream();
      break; // Stop buffering until next seek
    }
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
