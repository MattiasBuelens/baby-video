import type { BabyVideoElement } from "../src/index";

// Shows the frame counters of the element: what requestVideoFrameCallback()
// tells us about each presented frame, and getVideoPlaybackQuality().
export function setupFrameStats(
  video: BabyVideoElement,
  container: HTMLElement
): void {
  const stat = (name: string) =>
    container.querySelector<HTMLElement>(`[data-stat="${name}"]`)!;
  const presented = stat("presented");
  const dropped = stat("dropped");
  const total = stat("total");
  const rate = stat("rate");
  const mediaTime = stat("media-time");
  const size = stat("size");
  const processing = stat("processing");

  // The callback rate over the last second of callbacks.
  const callbackTimes: number[] = [];

  function updateQuality() {
    const quality = video.getVideoPlaybackQuality();
    dropped.textContent = String(quality.droppedVideoFrames);
    total.textContent = String(quality.totalVideoFrames);
  }

  function onVideoFrame(now: number, metadata: VideoFrameCallbackMetadata) {
    presented.textContent = String(metadata.presentedFrames);
    mediaTime.textContent = `${metadata.mediaTime.toFixed(3)} s`;
    size.textContent = `${metadata.width}×${metadata.height}`;
    processing.textContent =
      metadata.processingDuration === undefined
        ? "–"
        : `${(metadata.processingDuration * 1000).toFixed(1)} ms`;
    callbackTimes.push(now);
    while (callbackTimes.length > 0 && callbackTimes[0] < now - 1000) {
      callbackTimes.shift();
    }
    rate.textContent = `${callbackTimes.length} fps`;
    updateQuality();
    video.requestVideoFrameCallback(onVideoFrame);
  }
  video.requestVideoFrameCallback(onVideoFrame);

  // Frames can be dropped without presenting a new one, e.g. right before
  // pausing, and the counters reset when the source changes.
  for (const type of ["pause", "seeked", "emptied"]) {
    video.addEventListener(type, () => {
      callbackTimes.length = 0;
      rate.textContent = "–";
      updateQuality();
    });
  }
}
