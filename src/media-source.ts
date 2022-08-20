import { BabySourceBuffer } from "./source-buffer";

export type MediaSourceReadyState = "closed" | "ended" | "open";

export class BabyMediaSource {
  #readyState: MediaSourceReadyState = "closed";
  #sourceBuffers: BabySourceBuffer[] = [];

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
      throw new DOMException(`Ready state must be open`, "NotSupportedError");
    }
    // 5. Create a new SourceBuffer object and associated resources.
    const sourceBuffer = new BabySourceBuffer(this);
    // 6 and 7: Ignore.
    // 8. Add the new object to sourceBuffers and queue a task to fire an event named addsourcebuffer at sourceBuffers.
    this.#sourceBuffers.push(sourceBuffer);
    // 9. Return the new object.
    return sourceBuffer;
  }
}
