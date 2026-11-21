// Entry point for use inside a dedicated worker.
//
// Unlike ./index, this does not import the <baby-video> element, which can't
// be defined in a worker (there's no HTMLElement or customElements there).
//
//   const mediaSource = new BabyMediaSource();
//   const handle = mediaSource.handle;
//   postMessage({ handle }, [handle.port]);
//
// Then, on the main thread: video.srcObject = event.data.handle
export { BabyMediaSource } from "./media-source";
export { BabyMediaSourceHandle } from "./media-source-handle";
export { BabySourceBuffer } from "./source-buffer";
