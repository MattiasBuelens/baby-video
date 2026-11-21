// Test page for the content attributes, driven by test/attributes.spec.mjs.
// Unlike the other pages, the source isn't attached until the test says so,
// so it can set attributes first.
import type { BabyVideoElement } from "../src/index";
import { attachSource } from "./attach-source";
import type { SourceCommand } from "./source-driver";

const [video, mutedVideo] =
  document.querySelectorAll<BabyVideoElement>("baby-video");

const events: string[] = [];
for (const type of [
  "loadedmetadata",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "ended",
  "ratechange"
]) {
  video.addEventListener(type, () => events.push(type));
}

let run: ((command: SourceCommand) => Promise<void>) | undefined;

declare global {
  interface Window {
    video: BabyVideoElement;
    mutedVideo: BabyVideoElement;
    events: string[];
    // Attaches a source.
    attach(): Promise<void>;
    // Appends all media to the attached source.
    append(): Promise<void>;
    // Both of the above.
    load(): Promise<void>;
    run(command: SourceCommand): Promise<void>;
    isPosterShown(): boolean;
  }
}
window.video = video;
window.mutedVideo = mutedVideo;
window.events = events;
window.attach = async () => {
  ({ run } = await attachSource(video));
  await run({ type: "wait-for-open" });
};
window.append = async () => {
  await run!({ type: "append-media" });
  await run!({ type: "end-of-stream" });
};
window.run = (command) => run!(command);
window.load = async () => {
  await window.attach();
  await window.append();
};
window.isPosterShown = () => {
  const poster = video.shadowRoot!.querySelector<HTMLImageElement>(".poster")!;
  return !poster.hidden && poster.complete && poster.naturalWidth > 0;
};
document.body.dataset.ready = "true";
