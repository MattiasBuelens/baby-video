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
let secondAttach: Promise<void> | undefined;
worker.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;
  messages.push(message.type);
  if (message.type === "handle") {
    video.srcObject = message.handle;
    secondAttach = attachAgain(message.handle);
  } else if (message.type === "info") {
    Object.assign(result, message);
  } else if (message.type === "sourceopen") {
    // Detaching closes the MediaSource in the worker.
    video.srcObject = undefined;
  } else if (message.type === "sourceclose") {
    await secondAttach;
    result.messages = messages;
    (window as any).result = result;
    document.body.dataset.ready = "true";
  }
});

// Attaching a handle again fails like loading an unsupported resource.
async function attachAgain(handle: BabyVideoElement["srcObject"]) {
  const errorEvent = new Promise<void>((resolve) =>
    otherVideo.addEventListener("error", () => resolve(), { once: true })
  );
  const playResult = otherVideo.play().then(
    () => "resolved",
    (e: DOMException) => e.name
  );
  otherVideo.srcObject = handle;
  await errorEvent;
  result.secondAttachError = await playResult;
  result.secondAttachErrorCode = otherVideo.error?.code;
  result.secondAttachNetworkState = otherVideo.networkState;
}
