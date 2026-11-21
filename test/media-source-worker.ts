// Worker for test/audio-glitch.html?worker: creates the MediaSource in a
// dedicated worker, and loads the same fixtures as the page does otherwise.
import { BabyMediaSource } from "../src/worker";
import { waitForEvent } from "../src/util";
import audioUrl from "./fixtures/sine-440.m4a?url";
import videoUrl from "./fixtures/video.m4v?url";

const mediaSource = new BabyMediaSource();
const handle = mediaSource.handle;
postMessage({ type: "handle", handle }, [handle.port]);

await waitForEvent(mediaSource, "sourceopen");
async function append(type: string, url: string) {
  const sourceBuffer = mediaSource.addSourceBuffer(type);
  sourceBuffer.appendBuffer(await (await fetch(url)).arrayBuffer());
  await waitForEvent(sourceBuffer, "updateend");
}
await Promise.all([
  append('video/mp4; codecs="avc1.64000d"', videoUrl),
  append('audio/mp4; codecs="mp4a.40.2"', audioUrl)
]);
mediaSource.endOfStream();
postMessage({ type: "ready" });
