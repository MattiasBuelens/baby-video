// Test page for media errors and the load algorithm,
// driven by test/errors.spec.mjs.
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { ErrorsSource, type ErrorsSourceCommand } from "./errors-source";

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

let run: (command: ErrorsSourceCommand) => Promise<void>;
let mediaSource: BabyMediaSource | undefined;
if (new URLSearchParams(location.search).has("worker")) {
  const worker = new Worker(new URL("./errors-worker.ts", import.meta.url), {
    type: "module"
  });
  let nextId = 0;
  const pending = new Map<number, (error?: string) => void>();
  await new Promise<void>((resolve) => {
    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "handle") {
        video.srcObject = message.handle;
        resolve();
      } else if (message.type === "done") {
        pending.get(message.id)!(message.error);
        pending.delete(message.id);
      }
    });
  });
  run = (command) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (error) =>
        error ? reject(new Error(error)) : resolve()
      );
      worker.postMessage({ id, command });
    });
} else {
  mediaSource = new BabyMediaSource();
  video.srcObject = mediaSource;
  const source = new ErrorsSource(mediaSource);
  run = (command) => source.run(command);
}

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
