import { BabySourceBuffer, getVideoTrackBuffer } from "./source-buffer";
import {
  BabyVideoElement,
  MediaReadyState,
  notifyEndOfStream,
  updateDuration,
  updateReadyState,
} from "./video-element";
import { queueTask } from "./util";
import { VideoTrackBuffer } from "./track-buffer";
import { setEndTimeOnLastRange, TimeRanges } from "./time-ranges";

export type MediaSourceReadyState = "closed" | "ended" | "open";

export let attachToMediaElement: (
  mediaSource: BabyMediaSource,
  mediaElement: BabyVideoElement
) => void;
export let detachFromMediaElement: (mediaSource: BabyMediaSource) => void;
export let durationChange: (
  mediaSource: BabyMediaSource,
  newDuration: number
) => void;
export let endOfStream: (
  mediaSource: BabyMediaSource,
  error?: "network" | "decode"
) => void;
export let getMediaElement: (
  mediaSource: BabyMediaSource
) => BabyVideoElement | undefined;
export let getBuffered: (mediaSource: BabyMediaSource) => TimeRanges;
export let getActiveVideoTrackBuffer: (
  mediaSource: BabyMediaSource
) => VideoTrackBuffer | undefined;
export let openIfEnded: (mediaSource: BabyMediaSource) => void;
export let checkBuffer: (mediaSource: BabyMediaSource) => void;

export class BabyMediaSource extends EventTarget {
  #duration: number = NaN;
  #mediaElement: BabyVideoElement | undefined;
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
    this.#durationChange(duration);
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

  endOfStream(error?: "network" | "decode"): void {
    // https://w3c.github.io/media-source/#dom-mediasource-endofstream
    // 1. If the readyState attribute is not "open"
    //    then throw an InvalidStateError exception and abort these steps.
    if (this.#readyState !== "open") {
      throw new DOMException("Ready state must be open", "InvalidStateError");
    }
    // 2. If the updating attribute equals true on any SourceBuffer in sourceBuffers,
    //    then throw an InvalidStateError exception and abort these steps.
    if (this.#sourceBuffers.some((sourceBuffer) => sourceBuffer.updating)) {
      throw new DOMException(
        "No source buffer must be updating",
        "InvalidStateError"
      );
    }
    // 3. Run the end of stream algorithm with the error parameter set to error.
    this.#endOfStream(error);
  }

  #attachToMediaElement(mediaElement: BabyVideoElement): void {
    // https://w3c.github.io/media-source/#mediasource-attach
    if (this.#readyState !== "closed") {
      throw new DOMException("Ready state must be closed", "InvalidStateError");
    }
    // Otherwise, the MediaSource was constructed in a Window:
    this.#mediaElement = mediaElement;
    // 4. Set the readyState attribute to "open".
    this.#readyState = "open";
    // 5. Queue a task to fire an event named sourceopen at the MediaSource.
    queueTask(() => this.dispatchEvent(new Event("sourceopen")));
  }

  #detachFromMediaElement(): void {
    // https://w3c.github.io/media-source/#mediasource-detach
    // Otherwise, the MediaSource was constructed in a Window:
    this.#mediaElement = undefined;
    // 3. Set the readyState attribute to "closed".
    this.#readyState = "closed";
    // 4. Update duration to NaN.
    this.#duration = NaN;
    // 5. Remove all the SourceBuffer objects from activeSourceBuffers.
    // 7. Remove all the SourceBuffer objects from sourceBuffers.
    this.#sourceBuffers.length = 0;
    // 9. Queue a task to fire an event named sourceclose at the MediaSource.
    queueTask(() => this.dispatchEvent(new Event("sourceclose")));
  }

  #durationChange(newDuration: number): void {
    // https://w3c.github.io/media-source/#duration-change-algorithm
    // 1. If the current value of duration is equal to new duration, then return.
    if (this.#duration === newDuration) {
      return;
    }
    // 5. Update duration to new duration.
    this.#duration = newDuration;
    // 6.1. Update the media element's duration to new duration.
    // 6.1. Run the HTMLMediaElement duration change algorithm.
    updateDuration(this.#mediaElement!, newDuration);
  }

  #endOfStream(error?: "network" | "decode") {
    // https://w3c.github.io/media-source/#dfn-end-of-stream
    // 1. Change the readyState attribute value to "ended".
    this.#readyState = "ended";
    // 2. Queue a task to fire an event named sourceended at the MediaSource.
    queueTask(() => this.dispatchEvent(new Event("sourceended")));
    // 3. If error is not set:
    if (!error) {
      // 3.1. Run the duration change algorithm with new duration set to
      //      the largest track buffer ranges end time across all the track buffers
      //      across all SourceBuffer objects in sourceBuffers.
      const largestEndTime = Math.max(
        ...this.#sourceBuffers.map((sourceBuffer) =>
          sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
        )
      );
      this.#durationChange(largestEndTime);
      // 3.2. Notify the media element that it now has all of the media data.
      notifyEndOfStream(this.#mediaElement!);
    } else if (error === "network") {
      // TODO
    } else if (error === "decode") {
      // TODO
    }
  }

  #openIfEnded() {
    // If the readyState attribute of the parent media source is in the "ended" state
    // then run the following steps:
    if (this.#readyState === "ended") {
      // Set the readyState attribute of the parent media source to "open"
      this.#readyState = "open";
      // Queue a task to fire an event named sourceopen at the parent media source.
      this.dispatchEvent(new Event("sourceopen"));
    }
  }

  #getActiveVideoTrackBuffer(): VideoTrackBuffer | undefined {
    for (const sourceBuffer of this.#sourceBuffers) {
      const videoTrackBuffer = getVideoTrackBuffer(sourceBuffer);
      if (videoTrackBuffer) {
        return videoTrackBuffer;
      }
    }
    return undefined;
  }

  #getBuffered(): TimeRanges {
    // https://w3c.github.io/media-source/#htmlmediaelement-extensions-buffered
    // 2.1. Let recent intersection ranges equal an empty TimeRanges object.
    let intersectionRanges = new TimeRanges([]);
    // 2.2. If activeSourceBuffers.length does not equal 0 then run the following steps:
    if (this.#sourceBuffers.length !== 0) {
      // 2.2.1. Let active ranges be the ranges returned by buffered for each SourceBuffer object in activeSourceBuffers.
      const activeRanges = this.#sourceBuffers.map(
        (sourceBuffer) => sourceBuffer.buffered
      );
      // 2.2.2. Let highest end time be the largest range end time in the active ranges.
      const highestEndTime = Math.max(...activeRanges.map(getHighestEndTime));
      // 2.2.3. Let recent intersection ranges equal a TimeRanges object containing a single range from 0 to highest end time.
      intersectionRanges = new TimeRanges([[0, highestEndTime]]);
      // 2.2.4. For each SourceBuffer object in activeSourceBuffers run the following steps:
      // 2.2.4.1. Let source ranges equal the ranges returned by the buffered attribute on the current SourceBuffer.
      for (let sourceRanges of activeRanges) {
        // 2.2.4.2. If readyState is "ended", then set the end time on the last range in source ranges to highest end time.
        if (this.#readyState === "ended") {
          sourceRanges = setEndTimeOnLastRange(sourceRanges, highestEndTime);
        }
        // 2.2.4.3. Let new intersection ranges equal the intersection between the recent intersection ranges and the source ranges.
        // 2.2.4.4. Replace the ranges in recent intersection ranges with the new intersection ranges.
        intersectionRanges = intersectionRanges.intersect(sourceRanges);
      }
    }
    return intersectionRanges;
  }

  #checkBuffer(): void {
    // https://w3c.github.io/media-source/#buffer-monitoring
    const mediaElement = this.#mediaElement!;
    const readyState = mediaElement.readyState;
    // If the HTMLMediaElement.readyState attribute equals HAVE_NOTHING:
    if (readyState === MediaReadyState.HAVE_NOTHING) {
      // Abort these steps.
      return;
    }
    const buffered = this.#getBuffered();
    const currentTime = mediaElement.currentTime;
    // If HTMLMediaElement.buffered does not contain a TimeRanges for the current playback position:
    if (!buffered.contains(currentTime)) {
      // Set the HTMLMediaElement.readyState attribute to HAVE_METADATA.
      updateReadyState(mediaElement, MediaReadyState.HAVE_METADATA);
      // Abort these steps.
      return;
    }
    // If HTMLMediaElement.buffered contains a TimeRanges that includes the current playback position
    // and enough data to ensure uninterrupted playback:
    // TODO
    // If HTMLMediaElement.buffered contains a TimeRanges that includes the current playback position
    // and some time beyond the current playback position, then run the following steps:
    if (buffered.containsRange(currentTime, currentTime + 0.1)) {
      // Set the HTMLMediaElement.readyState attribute to HAVE_FUTURE_DATA.
      // Playback may resume at this point if it was previously suspended by a transition to HAVE_CURRENT_DATA.
      updateReadyState(mediaElement, MediaReadyState.HAVE_FUTURE_DATA);
      // Abort these steps.
      return;
    }
    // If HTMLMediaElement.buffered contains a TimeRanges that ends at the current playback position
    // and does not have a range covering the time immediately after the current position:
    if (buffered.containsRangeEndingAt(currentTime)) {
      // Set the HTMLMediaElement.readyState attribute to HAVE_CURRENT_DATA.
      // Playback is suspended at this point since the media element doesn't have enough data to advance the media timeline.
      updateReadyState(mediaElement, MediaReadyState.HAVE_CURRENT_DATA);
      // Abort these steps.
      return;
    }
  }

  static {
    attachToMediaElement = (mediaSource, mediaElement) =>
      mediaSource.#attachToMediaElement(mediaElement);
    detachFromMediaElement = (mediaSource) =>
      mediaSource.#detachFromMediaElement();
    durationChange = (mediaSource, newDuration) =>
      mediaSource.#durationChange(newDuration);
    endOfStream = (mediaSource, error) => mediaSource.#endOfStream(error);
    getMediaElement = (mediaSource) => mediaSource.#mediaElement;
    getBuffered = (mediaSource) => mediaSource.#getBuffered();
    openIfEnded = (mediaSource) => mediaSource.#openIfEnded();
    getActiveVideoTrackBuffer = (mediaSource) =>
      mediaSource.#getActiveVideoTrackBuffer();
    checkBuffer = (mediaSource) => mediaSource.#checkBuffer();
  }
}

function getHighestEndTime(buffered: TimeRanges): number {
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
}
