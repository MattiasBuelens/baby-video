import "media-chrome";
import "media-chrome/menu";
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { TimeRanges } from "../src/time-ranges";
import {
  type BufferTrack,
  setupBufferView,
  sourceBufferTrack
} from "./buffer-view";
import { startBuffering } from "./buffering";
import type { PlaybackStateMessage, WorkerMessage } from "./worker";
import { setupEventLog } from "./event-log";

const video = document.querySelector<BabyVideoElement>("baby-video")!;
setupEventLog(video, document.querySelector(".event-log")!);
setupPlaybackButtons(video);

// Run the MediaSource (and with it, the whole media pipeline) in a dedicated
// worker with ?worker, or on the main thread otherwise.
const useWorker =
  new URLSearchParams(location.search).has("worker") &&
  BabyMediaSource.canConstructInDedicatedWorker;
setupModeToggle(useWorker);

const elementTrack: BufferTrack = {
  label: "<baby-video>.buffered",
  className: "buffer-row-element",
  buffered: () => video.buffered
};

if (useWorker) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module"
  });
  // The worker can't see the element, so tell it where playback is.
  const postPlaybackState = (event: Event) => {
    worker.postMessage({
      type: event.type as PlaybackStateMessage["type"],
      currentTime: video.currentTime,
      playbackRate: video.playbackRate
    } satisfies PlaybackStateMessage);
  };
  for (const type of ["timeupdate", "seeking", "ratechange"]) {
    video.addEventListener(type, postPlaybackState);
  }
  // The worker tells us what its SourceBuffers have buffered.
  const sourceBufferUpdates = new EventTarget();
  let videoBuffered = new TimeRanges([]);
  let audioBuffered = new TimeRanges([]);
  worker.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as WorkerMessage;
    if (message.type === "handle") {
      video.srcObject = message.handle;
    } else if (message.type === "buffered") {
      videoBuffered = new TimeRanges(message.video);
      audioBuffered = new TimeRanges(message.audio);
      sourceBufferUpdates.dispatchEvent(new Event("updateend"));
    }
  });
  setupBufferView(video, document.querySelector(".buffer-view")!, [
    elementTrack,
    {
      label: "video SourceBuffer (in worker)",
      className: "buffer-row-video",
      buffered: () => videoBuffered,
      updates: sourceBufferUpdates
    },
    {
      label: "audio SourceBuffer (in worker)",
      className: "buffer-row-audio",
      buffered: () => audioBuffered,
      updates: sourceBufferUpdates
    }
  ]);
} else {
  const mediaSource = new BabyMediaSource();
  video.srcObject = mediaSource;
  const { videoSourceBuffer, audioSourceBuffer } = await startBuffering(
    mediaSource,
    video
  );
  setupBufferView(video, document.querySelector(".buffer-view")!, [
    elementTrack,
    sourceBufferTrack(
      "video SourceBuffer",
      "buffer-row-video",
      videoSourceBuffer
    ),
    sourceBufferTrack(
      "audio SourceBuffer",
      "buffer-row-audio",
      audioSourceBuffer
    )
  ]);
}

// Shows which mode we're in, links to the other one, and offers to block the
// main thread to show the difference.
function setupModeToggle(useWorker: boolean) {
  const mode = document.querySelector<HTMLElement>(".pipeline-mode")!;
  const link = mode.querySelector<HTMLAnchorElement>("a")!;
  const label = mode.querySelector<HTMLElement>(".pipeline-mode-label")!;
  const url = new URL(location.href);
  if (useWorker) {
    label.textContent = "MediaSource and media pipeline run in a worker.";
    url.searchParams.delete("worker");
    link.textContent = "Run them on the main thread";
  } else {
    label.textContent =
      "MediaSource and media pipeline run on the main thread.";
    url.searchParams.set("worker", "");
    link.textContent = BabyMediaSource.canConstructInDedicatedWorker
      ? "Run them in a worker"
      : "";
  }
  link.href = url.href;
  mode
    .querySelector<HTMLButtonElement>("button[name=block]")!
    .addEventListener("click", () => {
      const end = performance.now() + 2000;
      while (performance.now() < end) {
        // Keep the main thread busy.
      }
    });
}

function setupPlaybackButtons(video: BabyVideoElement) {
  const buttons =
    document.querySelectorAll<HTMLButtonElement>("button[data-rate]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      video.playbackRate = Number(button.dataset.rate);
      void video.play();
    });
  });
  const updatePressed = () => {
    buttons.forEach((button) => {
      const pressed =
        !video.paused && Number(button.dataset.rate) === video.playbackRate;
      button.setAttribute("aria-pressed", String(pressed));
    });
  };
  for (const type of ["ratechange", "play", "pause", "ended"]) {
    video.addEventListener(type, updatePressed);
  }
}
