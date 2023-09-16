import "media-chrome";
import {
  BabyMediaSource,
  BabySourceBuffer,
  BabyVideoElement
} from "../src/index";
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
// video.addEventListener("timeupdate", logEvent);
video.addEventListener("durationchange", logEvent);
video.addEventListener("seeking", logEvent);
video.addEventListener("seeked", logEvent);
video.addEventListener("progress", logEvent);
video.addEventListener("resize", logEvent);
video.addEventListener("ended", logEvent);

const streamDuration = 634.56;

const mediaSource = new BabyMediaSource();
video.srcObject = mediaSource;
if (mediaSource.readyState !== "open") {
  await waitForEvent(mediaSource, "sourceopen");
}
mediaSource.duration = streamDuration;
const videoSourceBuffer = mediaSource.addSourceBuffer(
  'video/mp4; codecs="avc1.640028"'
);
const audioSourceBuffer = mediaSource.addSourceBuffer(
  'audio/mp4; codecs="mp4a.40.5"'
);
const videoSegmentURLs = [
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_0.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_1.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_1000k/bbb_30fps_640x360_1000k_2.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_0.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_2.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_3.m4v",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_4.m4v"
];
const audioSegmentURLs = [
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_0.m4a",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_1.m4a",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_2.m4a",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_3.m4a",
  "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_4.m4a"
];

async function appendSegments(
  sourceBuffer: BabySourceBuffer,
  segmentURLs: string[]
) {
  for (const segmentURL of segmentURLs) {
    const segmentData = await (await fetch(segmentURL)).arrayBuffer();
    sourceBuffer.appendBuffer(segmentData);
    await waitForEvent(sourceBuffer, "updateend");
  }
}

await Promise.all([
  appendSegments(videoSourceBuffer, videoSegmentURLs),
  appendSegments(audioSourceBuffer, audioSegmentURLs)
]);

interface Segment {
  url: string;
  startTime: number;
  endTime: number;
  isFirst: boolean;
  isLast: boolean;
}

function getSegmentForTime(
  templateUrl: string,
  segmentDuration: number,
  time: number
): Segment | undefined {
  const lastSegmentIndex = Math.ceil(streamDuration / segmentDuration) - 1;
  const segmentIndex = Math.max(
    0,
    Math.min(lastSegmentIndex, Math.floor(time / segmentDuration))
  );
  if (segmentIndex < 0) {
    return undefined;
  }
  const url = templateUrl.replace(/%INDEX%/, `${segmentIndex + 1}`);
  return {
    url,
    startTime: segmentIndex * segmentDuration,
    endTime: (segmentIndex + 1) * segmentDuration,
    isFirst: segmentIndex === 0,
    isLast: segmentIndex === lastSegmentIndex
  };
}

function getVideoSegmentForTime(time: number): Segment | undefined {
  return getSegmentForTime(
    "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_%INDEX%.m4v",
    120 / 30,
    time
  );
}

function getAudioSegmentForTime(time: number): Segment | undefined {
  return getSegmentForTime(
    "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_%INDEX%.m4a",
    192512 / 48000,
    time
  );
}

const forwardBufferSize = 30;
const backwardBufferSize = 10;

let pendingBufferLoop: Promise<void> = Promise.resolve();

async function trackBufferLoop(
  sourceBuffer: BabySourceBuffer,
  segmentForTime: (time: number) => Segment | undefined,
  signal: AbortSignal
) {
  while (true) {
    if (signal.aborted) throw signal.reason;
    // Check buffer health
    while (true) {
      const currentRange = sourceBuffer.buffered.find(video.currentTime);
      const forward = video.playbackRate >= 0;
      if (!currentRange) {
        // No buffer, need new segment immediately
        break;
      }
      if (forward) {
        if (currentRange[1] - video.currentTime <= 20) {
          // Not enough buffer ahead of current time
          break;
        }
      } else {
        if (video.currentTime - currentRange[0] <= 20) {
          // Not enough buffer behind current time
          break;
        }
      }
      // Still enough buffer, wait for playback to progress
      await waitForEvent(video, ["timeupdate", "ratechange"], signal);
    }
    // Find next segment
    const currentRange = sourceBuffer.buffered.find(video.currentTime);
    const forward = video.playbackRate >= 0;
    const nextTime = currentRange
      ? forward
        ? currentRange[1]
        : currentRange[0] - 0.001
      : video.currentTime;
    const nextSegment = segmentForTime(nextTime)!;
    // Remove old buffer before/after current time
    const retainStart =
      video.currentTime - (forward ? backwardBufferSize : forwardBufferSize);
    const retainEnd =
      video.currentTime + (forward ? forwardBufferSize : backwardBufferSize);
    const oldBuffered = sourceBuffer.buffered.subtract(
      new TimeRanges([[retainStart, retainEnd]])
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
    if (forward) {
      if (nextSegment.isLast) {
        // FIXME Wait for all tracks to reach last segment
        mediaSource.endOfStream();
        break; // Stop buffering until next seek
      }
    } else {
      if (nextSegment.isFirst) {
        break; // Stop buffering until next seek
      }
    }
  }
}

async function bufferLoop(signal: AbortSignal) {
  await pendingBufferLoop;
  await Promise.allSettled([
    trackBufferLoop(videoSourceBuffer, getVideoSegmentForTime, signal),
    trackBufferLoop(audioSourceBuffer, getAudioSegmentForTime, signal)
  ]);
}

let bufferAbortController: AbortController = new AbortController();

function restartBuffering() {
  bufferAbortController.abort();
  bufferAbortController = new AbortController();
  pendingBufferLoop = bufferLoop(bufferAbortController.signal).catch(() => {});
}

video.addEventListener("seeking", restartBuffering);
video.addEventListener("ratechange", restartBuffering);
restartBuffering();

function logEvent(event: Event) {
  console.log(`${event.type} @ ${video.currentTime}`);
}
