import stylesheet from "./style.css";
import {
  attachToMediaElement,
  BabyMediaSource,
  checkBuffer,
  detachFromMediaElement,
  getActiveVideoTrackBuffer,
  getBuffered,
} from "./media-source";
import { Deferred, queueTask, waitForEvent } from "./util";
import { TimeRanges } from "./time-ranges";

const template = document.createElement("template");
template.innerHTML = `<style>${stylesheet}</style>`;

export enum MediaReadyState {
  HAVE_NOTHING,
  HAVE_METADATA,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_ENOUGH_DATA,
}

export let updateDuration: (
  videoElement: BabyVideoElement,
  newDuration: number
) => void;
export let updateReadyState: (
  videoElement: BabyVideoElement,
  newReadyState: MediaReadyState
) => void;
export let notifyProgress: (videoElement: BabyVideoElement) => void;

export class BabyVideoElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement;
  readonly #canvasContext: CanvasRenderingContext2D;

  #currentTime: number = 0;
  #duration: number = NaN;
  #ended: boolean = false;
  #paused: boolean = true;
  #readyState: MediaReadyState = MediaReadyState.HAVE_NOTHING;
  #seeking: boolean = false;
  #srcObject: BabyMediaSource | undefined;

  #pendingPlayPromises: Array<Deferred<void>> = [];
  #advanceLoop: number = 0;
  #lastAdvanceTime: number = 0;
  #lastTimeUpdate: number = 0;
  #lastProgress: number = 0;
  #nextProgressTimer: number = 0;
  #hasFiredLoadedData: boolean = false;
  #seekAbortController: AbortController = new AbortController();

  readonly #videoDecoder: VideoDecoder;
  #lastVideoDecoderConfig: VideoDecoderConfig | undefined = undefined;
  #lastDecodingVideoFrame: EncodedVideoChunk | undefined = undefined;
  #decodingVideoFrames: EncodedVideoChunk[] = [];
  #decodedVideoFrames: VideoFrame[] = [];
  #nextRenderFrame: number = 0;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(template.content.cloneNode(true));

    this.#canvas = document.createElement("canvas");
    // The default object size is a width of 300 CSS pixels and a height of 150 CSS pixels.
    this.#canvas.width = 300;
    this.#canvas.height = 150;
    shadow.appendChild(this.#canvas);

    this.#canvasContext = this.#canvas.getContext("2d")!;
    this.#canvasContext.fillStyle = "black";
    this.#canvasContext.fillRect(0, 0, this.#canvas.width, this.#canvas.height);

    this.#videoDecoder = new VideoDecoder({
      output: (frame) => this.#onVideoFrame(frame),
      error: (error) => console.error("WTF", error),
    });
  }

  connectedCallback(): void {
    // Consider checking for properties that may have been set
    // before the element upgraded.
    // https://web.dev/custom-elements-best-practices/
    this.#upgradeProperty("srcObject");
    this.#upgradeProperty("currentTime");
  }

  #upgradeProperty(prop: keyof this) {
    if (this.hasOwnProperty(prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  get buffered(): TimeRanges {
    return this.#srcObject ? getBuffered(this.#srcObject) : new TimeRanges([]);
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    value = Number(value);
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-currenttime
    // On setting, if the media element's readyState is HAVE_NOTHING,
    // then it must set the media element's default playback start position to the new value;
    // otherwise, it must set the official playback position to the new value and then seek to the new value.
    if (this.#readyState === MediaReadyState.HAVE_NOTHING) {
      // TODO
    } else {
      this.#seek(value);
    }
  }

  get duration(): number {
    return this.#duration;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get readyState(): MediaReadyState {
    return this.#readyState;
  }

  get seeking(): boolean {
    return this.#seeking;
  }

  get srcObject(): BabyMediaSource | undefined {
    return this.#srcObject;
  }

  set srcObject(srcObject: BabyMediaSource | undefined) {
    if (this.#srcObject) {
      detachFromMediaElement(this.#srcObject);
    }
    this.#srcObject = srcObject;
    this.#currentTime = 0;
    this.#duration = NaN;
    this.#hasFiredLoadedData = false;
    this.#ended = false;
    this.#paused = true;
    this.#readyState = MediaReadyState.HAVE_NOTHING;
    this.#seeking = false;
    this.#seekAbortController.abort();
    this.#lastAdvanceTime = 0;
    this.#lastProgress = 0;
    clearTimeout(this.#nextProgressTimer);
    this.#lastTimeUpdate = 0;
    this.#updatePlaying();
    queueTask(() => this.dispatchEvent(new Event("emptied")));
    if (srcObject) {
      attachToMediaElement(srcObject, this);
    }
  }

  get videoWidth(): number {
    return this.#canvas.width;
  }

  get videoHeight(): number {
    return this.#canvas.height;
  }

  play(): Promise<void> {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-play
    // 3. Let promise be a new promise and append promise to the list of pending play promises.
    const deferred = new Deferred<void>();
    this.#pendingPlayPromises.push(deferred);
    // 4. Run the internal play steps for the media element.
    this.#internalPlay();
    // 5. Return promise.
    return deferred.promise;
  }

  #takePendingPlayPromises(): Array<Deferred<void>> {
    // https://html.spec.whatwg.org/multipage/media.html#take-pending-play-promises
    const pendingPlayPromises = this.#pendingPlayPromises.slice();
    this.#pendingPlayPromises.length = 0;
    return pendingPlayPromises;
  }

  #notifyAboutPlaying(): void {
    // https://html.spec.whatwg.org/multipage/media.html#notify-about-playing
    // 1. Take pending play promises and let promises be the result.
    const promises = this.#takePendingPlayPromises();
    // 2. Queue a media element task given the element and the following steps:
    queueTask(() => {
      // 2.1. Fire an event named playing at the element.
      this.dispatchEvent(new Event("playing"));
      // 2.2. Resolve pending play promises with promises.
      promises.forEach((deferred) => deferred.resolve());
    });
    this.#updatePlaying();
  }

  #internalPlay(): void {
    // https://html.spec.whatwg.org/multipage/media.html#internal-play-steps
    // 2. If the playback has ended and the direction of playback is forwards,
    //    seek to the earliest possible position of the media resource.
    if (this.#ended) {
      this.#seek(0);
    }
    if (this.#paused) {
      // 3. If the media element's paused attribute is true, then:
      // 3.1. Change the value of paused to false.
      this.#paused = false;
      // 3.3. Queue a media element task given the media element to fire an event named play at the element.
      queueTask(() => this.dispatchEvent(new Event("play")));
      if (this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA) {
        // 3.4. If the media element's readyState attribute has the value HAVE_NOTHING, HAVE_METADATA, or HAVE_CURRENT_DATA,
        //      queue a media element task given the media element to fire an event named waiting at the element.
        queueTask(() => this.dispatchEvent(new Event("waiting")));
      } else {
        // 3.4. Otherwise, the media element's readyState attribute has the value HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA:
        //      notify about playing for the element.
        this.#notifyAboutPlaying();
      }
    } else if (this.#readyState >= MediaReadyState.HAVE_FUTURE_DATA) {
      // 4. Otherwise, if the media element's readyState attribute has the value HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA,
      //    take pending play promises and queue a media element task given the media element
      //    to resolve pending play promises with the result.
      const promises = this.#takePendingPlayPromises();
      queueTask(() => promises.forEach((deferred) => deferred.resolve()));
    }
  }

  pause(): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-pause
    this.#internalPause();
  }

  #internalPause(): void {
    // https://html.spec.whatwg.org/multipage/media.html#internal-pause-steps
    // 2. If the media element's paused attribute is false, run the following steps:
    if (!this.#paused) {
      const now = performance.now();
      const currentPlaybackPosition = this.#getCurrentPlaybackPosition(now);
      // 2.1. Change the value of paused to true.
      this.#paused = true;
      // 2.2. Take pending play promises and let promises be the result.
      const promises = this.#takePendingPlayPromises();
      // 2.3. Queue a media element task given the media element and the following steps:
      queueTask(() => {
        // 2.3.1. Fire an event named timeupdate at the element.
        this.dispatchEvent(new Event("timeupdate"));
        // 2.3.2. Fire an event named pause at the element.
        this.dispatchEvent(new Event("pause"));
        // 2.3.3. Reject pending play promises with promises and an "AbortError" DOMException.
        const error = new DOMException(
          "Aborted by a call to pause()",
          "AbortError"
        );
        promises.forEach((deferred) => deferred.reject(error));
        // 2.4. Set the official playback position to the current playback position.
        this.#updateCurrentTime(currentPlaybackPosition);
        this.#timeMarchesOn(false, now);
      });
      this.#updatePlaying();
    }
  }

  #updatePlaying(): void {
    if (this.#isPotentiallyPlaying()) {
      if (this.#advanceLoop === 0) {
        this.#lastAdvanceTime = performance.now();
        this.#advanceLoop = requestAnimationFrame((now) => {
          this.#advanceCurrentTime(now);
        });
      }
    } else if (this.#advanceLoop !== 0) {
      cancelAnimationFrame(this.#advanceLoop);
      this.#advanceLoop = 0;
    }
  }

  #getCurrentPlaybackPosition(now: number): number {
    // When a media element is potentially playing and its Document is a fully active Document,
    // its current playback position must increase monotonically at the element's playbackRate units
    // of media time per unit time of the media timeline's clock.
    if (this.#isPotentiallyPlaying()) {
      const newTime =
        this.#currentTime + Math.max(0, now - this.#lastAdvanceTime) / 1000;
      // Do not advance past end of current buffered range.
      const currentRange = this.buffered.find(this.#currentTime)!;
      return Math.min(newTime, currentRange[1]);
    } else {
      return this.#currentTime;
    }
  }

  #updateCurrentTime(currentTime: number) {
    this.#currentTime = currentTime;
    this.#decodeVideoFrames();
    if (this.#srcObject) {
      checkBuffer(this.#srcObject);
    }
  }

  #advanceCurrentTime(now: number): void {
    this.#updateCurrentTime(this.#getCurrentPlaybackPosition(now));
    this.#lastAdvanceTime = now;
    this.#timeMarchesOn(true, now);
    if (this.#isPotentiallyPlaying()) {
      this.#advanceLoop = requestAnimationFrame((now) =>
        this.#advanceCurrentTime(now)
      );
    }
  }

  #timeMarchesOn(isNormalPlayback: boolean, now: number): void {
    // https://html.spec.whatwg.org/multipage/media.html#time-marches-on
    // 6. If the time was reached through the usual monotonic increase of the current playback position during normal playback,
    //    and if the user agent has not fired a timeupdate event at the element in the past 15 to 250ms
    //    and is not still running event handlers for such an event,
    //    then the user agent must queue a media element task given the media element to fire an event
    //    named timeupdate at the element.
    if (isNormalPlayback && now - this.#lastTimeUpdate > 15) {
      this.#lastTimeUpdate = now;
      queueTask(() => this.dispatchEvent(new Event("timeupdate")));
    }
  }

  #seek(newPosition: number): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
    // 2. If the media element's readyState is HAVE_NOTHING, return.
    if (this.#readyState === MediaReadyState.HAVE_NOTHING) {
      return;
    }
    // 3. If the element's seeking IDL attribute is true, then another instance of this algorithm is already running.
    //    Abort that other instance of the algorithm without waiting for the step that it is running to complete.
    if (this.#seeking) {
      this.#seekAbortController.abort();
    }
    // 4. Set the seeking IDL attribute to true.
    this.#seeking = true;
    // 6. If the new playback position is later than the end of the media resource,
    //    then let it be the end of the media resource instead.
    const duration = this.duration;
    if (!Number.isNaN(duration) && newPosition > duration) {
      newPosition = this.duration;
    }
    // 7. If the new playback position is less than the earliest possible position, let it be that position instead.
    if (newPosition < 0) {
      newPosition = 0;
    }
    // 10. Queue a media element task given the media element to fire an event named seeking at the element.
    queueTask(() => this.dispatchEvent(new Event("seeking")));
    // 11. Set the current playback position to the new playback position.
    this.#resetVideoDecoder();
    this.#updateCurrentTime(newPosition);
    this.#updatePlaying();
    // 12. Wait until the user agent has established whether or not the media data for the new playback position
    //     is available, and, if it is, until it has decoded enough data to play back that position.
    this.#seekAbortController = new AbortController();
    this.#waitForSeekToComplete(this.#seekAbortController.signal).catch(
      () => {}
    );
  }

  async #waitForSeekToComplete(signal: AbortSignal): Promise<void> {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
    // 12. Wait until the user agent has established whether or not the media data for the new playback position
    //     is available, and, if it is, until it has decoded enough data to play back that position.
    while (this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA) {
      await waitForEvent(this, "canplay", signal);
    }
    // 13. Await a stable state.
    // 14. Set the seeking IDL attribute to false.
    this.#seeking = false;
    // 15. Run the time marches on steps.
    this.#timeMarchesOn(false, performance.now());
    // 16. Queue a media element task given the media element to fire an event named timeupdate at the element.
    queueTask(() => this.dispatchEvent(new Event("timeupdate")));
    // 17. Queue a media element task given the media element to fire an event named seeked at the element.
    queueTask(() => this.dispatchEvent(new Event("seeked")));
  }

  #decodeVideoFrames(): void {
    const mediaSource = this.#srcObject;
    if (!mediaSource) {
      return;
    }
    const videoTrackBuffer = getActiveVideoTrackBuffer(mediaSource);
    if (!videoTrackBuffer) {
      return;
    }
    const frameAtTime = videoTrackBuffer.findFrameForTime(this.currentTime);
    if (frameAtTime && this.#lastDecodingVideoFrame !== frameAtTime) {
      const decodeQueue = videoTrackBuffer.getDecodeQueueForFrame(
        frameAtTime,
        this.#lastDecodingVideoFrame
      );
      if (
        this.#videoDecoder.state === "unconfigured" ||
        this.#lastVideoDecoderConfig !== decodeQueue.codecConfig
      ) {
        this.#videoDecoder.configure(decodeQueue.codecConfig);
        this.#lastVideoDecoderConfig = decodeQueue.codecConfig;
      }
      this.#lastDecodingVideoFrame = frameAtTime;
      for (const frame of decodeQueue.frames) {
        this.#videoDecoder.decode(frame);
        this.#decodingVideoFrames.push(frame);
      }
    }
  }

  #onVideoFrame(frame: VideoFrame): void {
    const decodingFrameIndex = this.#decodingVideoFrames.findIndex(
      (x) => x.timestamp === frame.timestamp
    );
    if (decodingFrameIndex < 0) {
      // Drop frames that are no longer in the decode queue.
      frame.close();
      return;
    }
    const decodingFrame = this.#decodingVideoFrames[decodingFrameIndex];
    this.#decodingVideoFrames.splice(decodingFrameIndex, 1);
    // Drop frames that are before current time, since we're too late to render them.
    const currentTimeInMicros = 1e6 * this.#currentTime;
    if (
      decodingFrame.timestamp! + decodingFrame.duration! <=
      currentTimeInMicros
    ) {
      frame.close();
      return;
    }
    // Note: Chrome does not yet copy EncodedVideoChunk.duration to VideoFrame.duration
    const newFrame = new VideoFrame(frame as unknown as CanvasImageSource, {
      duration: decodingFrame.duration!,
    });
    frame.close();
    frame = newFrame;
    this.#decodedVideoFrames.push(newFrame);
    if (this.#nextRenderFrame === 0) {
      this.#nextRenderFrame = requestAnimationFrame(() =>
        this.#renderVideoFrame()
      );
    }
  }

  #renderVideoFrame(): void {
    const currentTimeInMicros = 1e6 * this.#currentTime;
    // Drop all frames that are before current time, since we're too late to render them.
    let nbOfDroppedFrames = 0;
    for (let i = 0; i < this.#decodedVideoFrames.length; i++) {
      const frame = this.#decodedVideoFrames[i];
      if (frame.timestamp! + frame.duration! <= currentTimeInMicros) {
        frame.close();
        nbOfDroppedFrames++;
      }
    }
    this.#decodedVideoFrames.splice(0, nbOfDroppedFrames);
    // Render the frame at current time.
    let currentFrameIndex = this.#decodedVideoFrames.findIndex((frame) => {
      return (
        frame.timestamp! <= currentTimeInMicros &&
        currentTimeInMicros < frame.timestamp! + frame.duration!
      );
    });
    if (currentFrameIndex >= 0) {
      const frame = this.#decodedVideoFrames[currentFrameIndex];
      this.#updateSize(frame.displayWidth, frame.displayHeight);
      this.#canvasContext.drawImage(
        frame,
        0,
        0,
        frame.displayWidth,
        frame.displayHeight
      );
      frame.close();
      this.#decodedVideoFrames.splice(currentFrameIndex, 1);
    }
    // Schedule the next render.
    if (this.#decodedVideoFrames.length > 0 && this.#isPotentiallyPlaying()) {
      this.#nextRenderFrame = requestAnimationFrame(() =>
        this.#renderVideoFrame()
      );
    } else {
      this.#nextRenderFrame = 0;
    }
  }

  #resetVideoDecoder(): void {
    for (const frame of this.#decodedVideoFrames) {
      frame.close();
    }
    this.#lastVideoDecoderConfig = undefined;
    this.#lastDecodingVideoFrame = undefined;
    this.#decodingVideoFrames.length = 0;
    this.#decodedVideoFrames.length = 0;
    this.#videoDecoder.reset();
  }

  #isPotentiallyPlaying(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#potentially-playing
    return !this.#paused && !this.#ended && !this.#isBlocked();
  }

  #isBlocked(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#blocked-media-element
    return this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA;
  }

  #updateDuration(newDuration: number): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-duration
    const oldDuration = this.#duration;
    this.#duration = newDuration;
    // When the length of the media resource changes to a known value
    // (e.g. from being unknown to known, or from a previously established length to a new length)
    // the user agent must queue a media element task given the media element to fire an event named durationchange at the media element.
    if (
      (Number.isNaN(oldDuration) && !Number.isNaN(newDuration)) ||
      oldDuration !== newDuration
    ) {
      queueTask(() => this.dispatchEvent(new Event("durationchange")));
    }
    // If the duration is changed such that the current playback position ends up being greater than
    // the time of the end of the media resource, then the user agent must also seek to
    // the time of the end of the media resource.
    if (this.currentTime > newDuration) {
      this.#seek(newDuration);
    }
  }

  #updateReadyState(newReadyState: MediaReadyState): void {
    const wasPotentiallyPlaying = this.#isPotentiallyPlaying();
    const previousReadyState = this.#readyState;
    this.#readyState = newReadyState;
    this.#updatePlaying();
    // TODO https://html.spec.whatwg.org/multipage/media.html#ready-states
    // If the previous ready state was HAVE_NOTHING, and the new ready state is HAVE_METADATA
    if (
      previousReadyState === MediaReadyState.HAVE_NOTHING &&
      newReadyState === MediaReadyState.HAVE_METADATA
    ) {
      // Queue a media element task given the media element to fire an event named loadedmetadata at the element.
      queueTask(() => this.dispatchEvent(new Event("loadedmetadata")));
      return;
    }
    // If the previous ready state was HAVE_METADATA and the new ready state is HAVE_CURRENT_DATA or greater
    if (
      previousReadyState === MediaReadyState.HAVE_METADATA &&
      newReadyState >= MediaReadyState.HAVE_CURRENT_DATA
    ) {
      // If this is the first time this occurs for this media element since the load() algorithm was last invoked,
      // the user agent must queue a media element task given the media element to fire an event named loadeddata at the element.
      if (!this.#hasFiredLoadedData) {
        this.#hasFiredLoadedData = true;
        queueTask(() => this.dispatchEvent(new Event("loadeddata")));
      }
      // If the new ready state is HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA, then the relevant steps below must then be run also.
    }
    // If the previous ready state was HAVE_FUTURE_DATA or more, and the new ready state is HAVE_CURRENT_DATA or less
    if (
      previousReadyState >= MediaReadyState.HAVE_FUTURE_DATA &&
      newReadyState <= MediaReadyState.HAVE_CURRENT_DATA
    ) {
      // If the media element was potentially playing before its readyState attribute changed to a value lower than HAVE_FUTURE_DATA,
      // and the element has not ended playback, and playback has not stopped due to errors,
      // paused for user interaction, or paused for in-band content,
      // the user agent must queue a media element task given the media element to fire an event named timeupdate at the element,
      // and queue a media element task given the media element to fire an event named waiting at the element.
      if (wasPotentiallyPlaying && !this.#ended) {
        queueTask(() => this.dispatchEvent(new Event("timeupdate")));
        queueTask(() => this.dispatchEvent(new Event("waiting")));
      }
      return;
    }
    // If the previous ready state was HAVE_CURRENT_DATA or less, and the new ready state is HAVE_FUTURE_DATA
    // Note: this also handles the first steps of HAVE_ENOUGH_DATA
    if (
      previousReadyState <= MediaReadyState.HAVE_CURRENT_DATA &&
      newReadyState >= MediaReadyState.HAVE_FUTURE_DATA
    ) {
      // The user agent must queue a media element task given the media element to fire an event named canplay at the element.
      queueTask(() => this.dispatchEvent(new Event("canplay")));
      // If the element's paused attribute is false, the user agent must notify about playing for the element.
      if (!this.#paused) {
        this.#notifyAboutPlaying();
      }
    }
    // If the new ready state is HAVE_ENOUGH_DATA
    if (newReadyState === MediaReadyState.HAVE_ENOUGH_DATA) {
      // Note: the first step is handled together with HAVE_FUTURE_DATA
      // The user agent must queue a media element task given the media element to fire an event named canplaythrough at the element.
      queueTask(() => this.dispatchEvent(new Event("canplaythrough")));
    }
  }

  #updateSize(width: number, height: number): void {
    const oldWidth = this.#canvas.width;
    const oldHeight = this.#canvas.height;
    this.#canvas.width = width;
    this.#canvas.height = height;
    // https://html.spec.whatwg.org/multipage/media.html#concept-video-intrinsic-width
    // Whenever the intrinsic width or intrinsic height of the video changes
    // (including, for example, because the selected video track was changed),
    // if the element's readyState attribute is not HAVE_NOTHING,
    // the user agent must queue a media element task given the media element
    // to fire an event named resize at the media element.
    if (
      this.#readyState !== MediaReadyState.HAVE_NOTHING &&
      (oldWidth !== width || oldHeight !== height)
    ) {
      queueTask(() => this.dispatchEvent(new Event("resize")));
    }
  }

  #notifyProgress(): void {
    // https://html.spec.whatwg.org/multipage/media.html#concept-media-load-resource
    // While the load is not suspended (see below), every 350ms (±200ms) or for every byte received, whichever is least frequent,
    // queue a media element task given the media element to fire an event named progress at the element.
    clearTimeout(this.#nextProgressTimer);
    const now = performance.now();
    const timeUntilNextProgress = 350 - (now - this.#lastProgress);
    if (timeUntilNextProgress <= 0) {
      this.#lastProgress = now;
      queueTask(() => this.dispatchEvent(new Event("progress")));
    } else {
      this.#nextProgressTimer = setTimeout(
        () => this.#notifyProgress(),
        timeUntilNextProgress
      );
    }
  }

  static {
    updateDuration = (videoElement: BabyVideoElement, newDuration: number) => {
      videoElement.#updateDuration(newDuration);
    };
    updateReadyState = (
      videoElement: BabyVideoElement,
      newReadyState: MediaReadyState
    ) => {
      videoElement.#updateReadyState(newReadyState);
    };
    notifyProgress = (videoElement: BabyVideoElement) => {
      videoElement.#notifyProgress();
    };
  }
}

customElements.define("baby-video", BabyVideoElement);
