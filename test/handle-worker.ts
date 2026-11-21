// Worker for test/handle.html.
import { BabyMediaSource } from "../src/worker";

const mediaSource = new BabyMediaSource();
const handle = mediaSource.handle;
let secondTransferError: string | undefined;
postMessage({ type: "handle", handle }, [handle.port]);
try {
  postMessage({ type: "handle-again", handle }, [handle.port]);
} catch (e) {
  secondTransferError = (e as DOMException).name;
}
postMessage({
  type: "info",
  sameHandle: mediaSource.handle === handle,
  canConstructInDedicatedWorker: BabyMediaSource.canConstructInDedicatedWorker,
  secondTransferError
});
mediaSource.addEventListener("sourceopen", () => {
  postMessage({ type: "sourceopen" });
});
mediaSource.addEventListener("sourceclose", () => {
  postMessage({ type: "sourceclose" });
});
