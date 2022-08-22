import { BabySourceBuffer } from "./source-buffer";

export type MediaSourceReadyState = "closed" | "ended" | "open";

export let attachToMediaElement: (
  mediaSource: BabyMediaSource,
  mediaElement: BabyVideoElement
) => void;
export let detachFromMediaElement: (mediaSource: BabyMediaSource) => void;

export class BabyMediaSource extends EventTarget {
  #duration: number = NaN;
  #readyState: MediaSourceReadyState = "closed";
  #sourceBuffers: BabySourceBuffer[] = [];

  get duration(): number {
    // https://w3c.github.io/media-source/#dom-mediasource-duration
    if (this.#readyState === "closed") {
      return NaN;
    }
    return this.#duration;
  }

  set duration(duration: number) {
    // https://w3c.github.io/media-source/#dom-mediasource-duration
    // 1. If the value being set is negative or NaN
    //    then throw a TypeError exception and abort these steps.
    if (duration < 0 || Number.isNaN(duration)) {
      throw new TypeError("Invalid duration");
    }
    // 2. If the readyState attribute is not "open"
    //    then throw an InvalidStateError exception and abort these steps.
    if (this.#readyState !== "open") {
      throw new DOMException("Ready state must be open", "InvalidStateError");
    }
    // 3. If the updating attribute equals true on any SourceBuffer in sourceBuffers,
    //    then throw an InvalidStateError exception and abort these steps.
    if (this.#sourceBuffers.some((sourceBuffer) => sourceBuffer.updating)) {
      throw new DOMException(
        "No source buffer must be updating",
        "InvalidStateError"
      );
    }
    // 4. Run the duration change algorithm with new duration
    //   set to the value being assigned to this attribute.
    // TODO
    this.#duration = duration;
  }

  get readyState(): MediaSourceReadyState {
    return this.#readyState;
  }

  get sourceBuffers(): readonly BabySourceBuffer[] {
    return this.#sourceBuffers;
  }

  addSourceBuffer(type: string): BabySourceBuffer {
    // https://w3c.github.io/media-source/#dom-mediasource-addsourcebuffer
    // 1. If type is an empty string then throw a TypeError exception and abort these steps.
    // 2. If type contains a MIME type that is not supported or contains a MIME type that is not supported
    //    with the types specified for the other SourceBuffer objects in sourceBuffers,
    //    then throw a NotSupportedError exception and abort these steps.
    if (
      type === "" ||
      !(type.startsWith("audio/mp4") || type.startsWith("video/mp4"))
    ) {
      throw new DOMException(
        `Unsupported MIME type: ${type}`,
        "NotSupportedError"
      );
    }
    // 3. If the user agent can't handle any more SourceBuffer objects or if creating a SourceBuffer
    //    based on type would result in an unsupported SourceBuffer configuration,
    //    then throw a QuotaExceededError exception and abort these steps.
    // 4. If the readyState attribute is not in the "open" state then throw an InvalidStateError exception and abort these steps.
    if (this.#readyState !== "open") {
      throw new DOMException("Ready state must be open", "NotSupportedError");
    }
    // 5. Create a new SourceBuffer object and associated resources.
    const sourceBuffer = new BabySourceBuffer(this);
    // 6 and 7: Ignore.
    // 8. Add the new object to sourceBuffers and queue a task to fire an event named addsourcebuffer at sourceBuffers.
    this.#sourceBuffers.push(sourceBuffer);
    // 9. Return the new object.
    return sourceBuffer;
  }

  #attachToMediaElement(): void {
    // https://w3c.github.io/media-source/#mediasource-attach
    if (this.#readyState !== "closed") {
      throw new DOMException("Ready state must be closed", "InvalidStateError");
    }
    this.#readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }

  #detachFromMediaElement(): void {
    // https://w3c.github.io/media-source/#mediasource-detach
    // 3. Set the readyState attribute to "closed".
    this.#readyState = "closed";
    // 4. Update duration to NaN.
    this.#duration = NaN;
    // 5. Remove all the SourceBuffer objects from activeSourceBuffers.
    // 7. Remove all the SourceBuffer objects from sourceBuffers.
    this.#sourceBuffers.length = 0;
    // 9. Queue a task to fire an event named sourceclose at the MediaSource.
    this.dispatchEvent(new Event("sourceclose"));
  }

  static {
    attachToMediaElement = (mediaSource) => mediaSource.#attachToMediaElement();
    detachFromMediaElement = (mediaSource) =>
      mediaSource.#detachFromMediaElement();
  }
}
