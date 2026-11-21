// A handle to a BabyMediaSource that lives in a dedicated worker,
// like MediaSourceHandle.
// https://w3c.github.io/media-source/#mediasourcehandle
//
// Get one from BabyMediaSource.handle in the worker, transfer it to the main
// thread, and attach it to a <baby-video> element with srcObject.
//
// Unlike a real MediaSourceHandle, this is not a platform object, so it can't
// be transferred itself. Instead, transfer its port:
//
//   postMessage({ handle }, [handle.port]);
//
// The receiving side gets a plain object with that port, which srcObject
// accepts as is. A port can only be transferred once, so (just like the real
// thing) transferring the same handle twice throws a DataCloneError.
// https://w3c.github.io/media-source/#transfer
export class BabyMediaSourceHandle {
  // The element's end of the port to the media pipeline,
  // see MediaPipelineProxy and MediaPipelineEndpoint.
  readonly port: MessagePort;

  constructor(port: MessagePort) {
    this.port = port;
  }
}
