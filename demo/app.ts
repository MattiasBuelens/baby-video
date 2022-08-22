import { BabyMediaSource, BabyVideoElement } from "../src/index";

const video = document.querySelector<BabyVideoElement>("baby-video")!;
const mediaSource = new BabyMediaSource();
video.srcObject = mediaSource;
if (mediaSource.readyState !== "open") {
  await waitForEvent(mediaSource, "sourceopen");
}

const sourceBuffer = mediaSource.addSourceBuffer(`video/mp4`);
const segmentURLs = [
  "https://amssamples.streaming.mediaservices.windows.net/bb34a723-f69a-4231-afba-dc850f9e3da8/ChildOfThe90s.ism/QualityLevels(5944615)/Fragments(video=i,format=mpd-time-csf)",
  "https://amssamples.streaming.mediaservices.windows.net/bb34a723-f69a-4231-afba-dc850f9e3da8/ChildOfThe90s.ism/QualityLevels(5944615)/Fragments(video=0,format=mpd-time-csf)",
];
for (const segmentURL of segmentURLs) {
  const segmentData = await (await fetch(segmentURL)).arrayBuffer();
  sourceBuffer.appendBuffer(segmentData);
  await waitForEvent(sourceBuffer, "updateend");
}

function waitForEvent(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });
}
