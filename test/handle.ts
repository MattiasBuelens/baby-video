// Test page for BabyMediaSourceHandle, driven by test/handle.spec.mjs.
import { BabyMediaSource, BabyVideoElement } from "../src/index";

const [video, otherVideo] =
  document.querySelectorAll<BabyVideoElement>("baby-video");
const worker = new Worker(new URL("./handle-worker.ts", import.meta.url), {
  type: "module"
});
const messages: any[] = [];
const result: Record<string, unknown> = {
  canConstructInDedicatedWorkerInWindow:
    BabyMediaSource.canConstructInDedicatedWorker
};
worker.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  messages.push(message.type);
  if (message.type === "handle") {
    video.srcObject = message.handle;
    try {
      otherVideo.srcObject = message.handle;
    } catch (e) {
      result.secondAttachError = (e as DOMException).name;
    }
  } else if (message.type === "info") {
    Object.assign(result, message);
  } else if (message.type === "sourceopen") {
    // Detaching closes the MediaSource in the worker.
    video.srcObject = undefined;
  } else if (message.type === "sourceclose") {
    result.messages = messages;
    (window as any).result = result;
    document.body.dataset.ready = "true";
  }
});
