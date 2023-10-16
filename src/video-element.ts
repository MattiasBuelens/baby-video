import stylesheet from "./style.css?inline";
import {
  attachToMediaElement,
  BabyMediaSource,
  checkBuffer,
  detachFromMediaElement,
  getActiveAudioTrackBuffer,
  getActiveVideoTrackBuffer,
  getBuffered
} from "./media-source";
import {
  arrayRemove,
  arrayRemoveAt,
  Deferred,
  Direction,
  queueTask,
  sumWith,
  waitForEvent
} from "./util";
import { TimeRange, TimeRanges } from "./time-ranges";
import {
  AudioDecodeQueue,
  EncodedChunk,
  VideoDecodeQueue
} from "./track-buffer";

const template = document.createElement("template");
template.innerHTML = `<style>${stylesheet}</style>`;

export enum MediaReadyState {
  HAVE_NOTHING,
  HAVE_METADATA,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_ENOUGH_DATA
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
export let notifyEndOfStream: (videoElement: BabyVideoElement) => void;

// Low and high watermark for decode queue
// If the queue drops below the LWM, we try to fill it with up to HWM new frames
const decodeQueueLwm = 20;
const decodeQueueHwm = 30;

const DEBUG = false;

export class BabyVideoElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement;
  readonly #canvasContext: CanvasRenderingContext2D;

  #currentTime: number = 0;
  #duration: number = NaN;
  #ended: boolean = false;
  #muted: boolean = false;
  #paused: boolean = true;
  #playbackRate: number = 1;
  #played: TimeRanges = new TimeRanges([]);
  #readyState: MediaReadyState = MediaReadyState.HAVE_NOTHING;
  #seeking: boolean = false;
  #srcObject: BabyMediaSource | undefined;
  #volume: number = 1;

  #pendingPlayPromises: Array<Deferred<void>> = [];
  #advanceLoop: number = 0;
  #lastAdvanceTime: number = 0;
  #lastAudioTimestamp: number = 0;
  #lastPlayedTime: number = NaN;
  #lastTimeUpdate: number = 0;
  #lastProgress: number = 0;
  #nextProgressTimer: number = 0;
  #hasFiredLoadedData: boolean = false;
  #seekAbortController: AbortController = new AbortController();
  #isEndOfStream: boolean = false;

  readonly #videoDecoder: VideoDecoder;
  #lastVideoDecoderConfig: VideoDecoderConfig | undefined = undefined;
  #furthestDecodingVideoFrame: EncodedVideoChunk | undefined = undefined;
  #decodingVideoFrames: EncodedVideoChunk[] = [];
  #decodedVideoFrames: VideoFrame[] = [];
  #nextDecodedVideoFramePromise: Deferred<void> | undefined = undefined;
  #lastRenderedFrame: number | undefined = undefined;
  #nextRenderFrame: number = 0;

  readonly #audioDecoder: AudioDecoder;
  #lastAudioDecoderConfig: AudioDecoderConfig | undefined = undefined;
  #audioDecoderTimestamp: number = 0;
  #furthestDecodedAudioFrame: EncodedAudioChunk | undefined = undefined;
  #decodingAudioFrames: EncodedAudioChunk[] = [];
  #nextDecodedAudioFramePromise: Deferred<void> | undefined = undefined;
  #originalDecodingAudioFrames: WeakMap<EncodedAudioChunk, EncodedAudioChunk> =
    new WeakMap();
  #decodedAudioFrames: AudioData[] = [];

  #audioContext: AudioContext | undefined;
  #lastScheduledAudioFrameTime: number = -1;
  #scheduledAudioSourceNodes: Array<{
    node: AudioBufferSourceNode;
    timestamp: number;
  }> = [];
  #volumeGainNode: GainNode | undefined;

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

    if (typeof VideoDecoder !== "function") {
      throw new Error(`<baby-video>: This browser does not support WebCodecs.`);
    }
    this.#videoDecoder = new VideoDecoder({
      output: (frame) => this.#onVideoFrame(frame),
      error: (error) => console.error("WTF", error)
    });

    this.#audioDecoder = new AudioDecoder({
      output: (data) => this.#onAudioData(data),
      error: (error) => console.error("WTF", error)
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
    return this.#ended && this.#playbackRate >= 0;
  }

  get muted(): boolean {
    return this.#muted;
  }

  set muted(value: boolean) {
    if (this.#muted !== value) {
      this.#muted = value;
      this.dispatchEvent(new Event("volumechange"));
      this.#updateVolume();
    }
  }

  get paused(): boolean {
    return this.#paused;
  }

  get playbackRate(): number {
    return this.#playbackRate;
  }

  set playbackRate(value: number) {
    if (value === this.#playbackRate) {
      return;
    }
    const currentTime = this.#getCurrentPlaybackPosition(performance.now());
    if (Math.sign(value) !== Math.sign(this.#playbackRate)) {
      this.#resetVideoDecoder();
      this.#resetAudioDecoder();
    }
    this.#playbackRate = value;
    this.#updateCurrentTime(currentTime);
    this.#updatePlaying();
    this.#updatePlayed();
    this.#updateAudioPlaybackRate();
    this.dispatchEvent(new Event("ratechange"));
  }

  get played(): TimeRanges {
    return this.#played;
  }

  get readyState(): MediaReadyState {
    return this.#readyState;
  }

  get seekable(): TimeRanges {
    return new TimeRanges([[0, this.#duration]]);
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
    this.#played = new TimeRanges([]);
    this.#readyState = MediaReadyState.HAVE_NOTHING;
    this.#seeking = false;
    this.#seekAbortController.abort();
    this.#lastAdvanceTime = 0;
    this.#lastAudioTimestamp = 0;
    this.#lastProgress = 0;
    this.#lastPlayedTime = NaN;
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

  get volume(): number {
    return this.#volume;
  }

  set volume(value: number) {
    if (this.#volume !== value) {
      this.#volume = value;
      this.dispatchEvent(new Event("volumechange"));
      this.#updateVolume();
    }
  }

  load(): void {
    // TODO
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
    if (this.#playbackRate >= 0 && this.#ended) {
      this.#seek(0);
    }
    if (this.#paused) {
      // 3. If the media element's paused attribute is true, then:
      // 3.1. Change the value of paused to false.
      this.#paused = false;
      this.#updatePlayed();
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
      this.#updatePlayed();
      this.#paused = true;
      this.#updatePlayed();
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

  #updatePlayed(): void {
    if (this.#isPotentiallyPlaying() && !this.#seeking) {
      if (!isNaN(this.#lastPlayedTime)) {
        const newRange: TimeRange = [
          Math.min(this.#currentTime, this.#lastPlayedTime),
          Math.max(this.#currentTime, this.#lastPlayedTime)
        ];
        this.#played = this.#played.union(new TimeRanges([newRange]));
      }
      this.#lastPlayedTime = this.#currentTime;
    } else {
      this.#lastPlayedTime = NaN;
    }
  }

  #updatePlaying(): void {
    if (this.#isPotentiallyPlaying() && !this.#seeking) {
      void this.#audioContext?.resume();
      if (this.#advanceLoop === 0) {
        this.#lastAdvanceTime = performance.now();
        this.#lastAudioTimestamp = this.#audioContext?.currentTime ?? 0;
        this.#advanceLoop = requestAnimationFrame((now) => {
          this.#advanceCurrentTime(now);
        });
      }
    } else if (this.#advanceLoop !== 0) {
      void this.#audioContext?.suspend();
      cancelAnimationFrame(this.#advanceLoop);
      this.#advanceLoop = 0;
    }
  }

  #getCurrentPlaybackPosition(now: number): number {
    // When a media element is potentially playing and its Document is a fully active Document,
    // its current playback position must increase monotonically at the element's playbackRate units
    // of media time per unit time of the media timeline's clock.
    if (this.#isPotentiallyPlaying() && !this.#seeking) {
      let elapsedTime: number;
      // Use audio clock as sync, otherwise use wall-clock time.
      if (
        this.#audioContext !== undefined &&
        this.#audioContext.state === "running"
      ) {
        elapsedTime = this.#audioContext.currentTime - this.#lastAudioTimestamp;
      } else {
        elapsedTime = (now - this.#lastAdvanceTime) / 1000;
      }
      const newTime =
        this.#currentTime + this.#playbackRate * Math.max(0, elapsedTime);
      // Do not advance outside the current buffered range.
      const currentRange = this.buffered.find(this.#currentTime);
      if (currentRange !== undefined) {
        return Math.min(Math.max(currentRange[0], newTime), currentRange[1]);
      }
    }
    return this.#currentTime;
  }

  #updateCurrentTime(currentTime: number) {
    this.#currentTime = currentTime;
    this.#decodeVideoFrames();
    this.#decodeAudio();
    if (this.#srcObject) {
      checkBuffer(this.#srcObject);
    }
    this.#updatePlayed();
    this.#updateEnded();
  }

  #updateEnded() {
    const wasEnded = this.#ended;
    this.#ended = this.#hasEndedPlayback();
    if (wasEnded || !this.#ended) {
      return;
    }
    // When the current playback position reaches the end of the media resource
    // when the direction of playback is forwards, then the user agent must follow these steps:
    if (this.#playbackRate >= 0) {
      // 3. Queue a media element task given the media element and the following steps:
      queueTask(() => {
        // 3.1. Fire an event named timeupdate at the media element.
        this.dispatchEvent(new Event("timeupdate"));
        // 3.2. If the media element has ended playback, the direction of playback is forwards,
        //      and paused is false, then:
        if (this.#ended && this.#playbackRate >= 0 && !this.#paused) {
          // 3.2.1. Set the paused attribute to true.
          this.#paused = true;
          // 3.2.2. Fire an event named pause at the media element.
          this.dispatchEvent(new Event("pause"));
          // 3.2.3. Take pending play promises and reject pending play promises with the result and an "AbortError" DOMException.
          const error = new DOMException("Aborted because ended", "AbortError");
          this.#takePendingPlayPromises().forEach((deferred) =>
            deferred.reject(error)
          );
        }
        // 3.3. Fire an event named ended at the media element.
        this.dispatchEvent(new Event("ended"));
      });
    }
    // When the current playback position reaches the earliest possible position of the media resource
    // when the direction of playback is backwards, then the user agent must only queue a media element
    // task given the media element to fire an event named timeupdate at the element.
    else {
      queueTask(() => this.dispatchEvent(new Event("timeupdate")));
    }
  }

  #hasEndedPlayback(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#ended-playback
    if (this.#readyState < MediaReadyState.HAVE_METADATA) {
      return false;
    }
    if (this.#playbackRate >= 0) {
      return this.#isEndOfStream && this.#currentTime === this.#duration;
    } else {
      return this.#currentTime === 0;
    }
  }

  #advanceCurrentTime(now: number): void {
    this.#updateCurrentTime(this.#getCurrentPlaybackPosition(now));
    this.#renderVideoFrame();
    this.#renderAudio();
    this.#lastAdvanceTime = now;
    this.#lastAudioTimestamp = this.#audioContext?.currentTime ?? 0;
    this.#timeMarchesOn(true, now);
    if (this.#isPotentiallyPlaying() && !this.#seeking) {
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
    this.#updatePlayed();
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
    this.#resetAudioDecoder();
    this.#updateCurrentTime(newPosition);
    this.#updatePlaying();
    // 12. Wait until the user agent has established whether or not the media data for the new playback position
    //     is available, and, if it is, until it has decoded enough data to play back that position.
    this.#seekAbortController = new AbortController();
    this.#waitForSeekToComplete(
      Math.floor(1e6 * newPosition),
      this.#seekAbortController.signal
    ).catch(() => {});
  }

  async #waitForSeekToComplete(
    timeInMicros: number,
    signal: AbortSignal
  ): Promise<void> {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
    // 12. Wait until the user agent has established whether or not the media data for the new playback position
    //     is available, and, if it is, until it has decoded enough data to play back that position.
    while (true) {
      if (this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA) {
        await waitForEvent(this, "canplay", signal);
      } else if (!this.#hasDecodedVideoFrameAtTime(timeInMicros)) {
        await this.#waitForNextDecodedVideoFrame(signal);
      } else if (!this.#hasDecodedAudioFrameAtTime(timeInMicros)) {
        await this.#waitForNextDecodedAudioFrame(signal);
      } else {
        break;
      }
    }
    // 13. Await a stable state.
    // 14. Set the seeking IDL attribute to false.
    this.#seeking = false;
    this.#updatePlaying();
    this.#updatePlayed();
    // 15. Run the time marches on steps.
    this.#timeMarchesOn(false, performance.now());
    // 16. Queue a media element task given the media element to fire an event named timeupdate at the element.
    queueTask(() => this.dispatchEvent(new Event("timeupdate")));
    // 17. Queue a media element task given the media element to fire an event named seeked at the element.
    queueTask(() => this.dispatchEvent(new Event("seeked")));
  }

  #hasDecodedVideoFrameAtTime(timeInMicros: number): boolean {
    return this.#hasDecodedFrameAtTime(this.#decodedVideoFrames, timeInMicros);
  }

  #hasDecodedAudioFrameAtTime(timeInMicros: number): boolean {
    return this.#hasDecodedFrameAtTime(this.#decodedAudioFrames, timeInMicros);
  }

  #hasDecodedFrameAtTime(
    frames: ReadonlyArray<VideoFrame | AudioData>,
    timeInMicros: number
  ): boolean {
    return frames.some(
      (frame: VideoFrame | AudioData) =>
        frame.timestamp <= timeInMicros &&
        timeInMicros < frame.timestamp + frame.duration!
    );
  }

  async #waitForNextDecodedVideoFrame(signal: AbortSignal): Promise<void> {
    this.#nextDecodedVideoFramePromise = new Deferred<void>();
    this.#nextDecodedVideoFramePromise.follow(signal);
    await this.#nextDecodedVideoFramePromise.promise;
  }

  async #waitForNextDecodedAudioFrame(signal: AbortSignal): Promise<void> {
    this.#nextDecodedAudioFramePromise = new Deferred<void>();
    this.#nextDecodedAudioFramePromise.follow(signal);
    await this.#nextDecodedAudioFramePromise.promise;
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
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    // Check if last decoded frame still exists, i.e. it was not overwritten
    // or removed from the SourceBuffer
    if (
      this.#furthestDecodingVideoFrame !== undefined &&
      !videoTrackBuffer.hasFrame(this.#furthestDecodingVideoFrame)
    ) {
      if (DEBUG) {
        console.warn(
          `last decoded video frame was removed (timestamp=${
            this.#furthestDecodingVideoFrame.timestamp
          }), decoding from current time`
        );
      }
      this.#furthestDecodingVideoFrame = undefined;
    }
    // Decode frames for current time
    if (this.#furthestDecodingVideoFrame === undefined) {
      const frameAtTime = videoTrackBuffer.findFrameForTime(this.currentTime);
      if (frameAtTime === undefined) {
        return;
      }
      this.#processVideoDecodeQueue(
        videoTrackBuffer.getDecodeDependenciesForFrame(frameAtTime),
        direction
      );
    }
    // Decode next frames in advance
    while (
      this.#decodingVideoFrames.length + this.#decodedVideoFrames.length <
      decodeQueueLwm
    ) {
      const nextQueue = videoTrackBuffer.getNextFrames(
        this.#furthestDecodingVideoFrame!,
        decodeQueueHwm -
          (this.#decodingVideoFrames.length + this.#decodedVideoFrames.length),
        direction
      );
      if (nextQueue === undefined) {
        break;
      }
      this.#processVideoDecodeQueue(nextQueue, direction);
    }
  }

  #processVideoDecodeQueue(
    decodeQueue: VideoDecodeQueue,
    direction: Direction
  ): void {
    const { frames, codecConfig } = decodeQueue;
    if (DEBUG) {
      console.log(
        `decode video frames: timestamp=${frames[0].timestamp} count=${frames.length}`
      );
    }
    if (
      this.#videoDecoder.state === "unconfigured" ||
      this.#lastVideoDecoderConfig !== codecConfig
    ) {
      this.#videoDecoder.configure(codecConfig);
      this.#lastVideoDecoderConfig = codecConfig;
    }
    for (const frame of frames) {
      this.#videoDecoder.decode(frame);
      this.#decodingVideoFrames.push(frame);
    }
    // The "furthest decoded frame" depends on the rendering order,
    // since we must decode the frames in their original order.
    if (direction == Direction.FORWARD) {
      this.#furthestDecodingVideoFrame = frames[frames.length - 1];
    } else {
      this.#furthestDecodingVideoFrame = frames[0];
    }
  }

  async #onVideoFrame(frame: VideoFrame) {
    const decodingFrameIndex = this.#decodingVideoFrames.findIndex((x) =>
      isFrameTimestampEqual(x, frame)
    );
    if (decodingFrameIndex < 0) {
      // Drop frames that are no longer in the decode queue.
      if (DEBUG) {
        console.log(
          `dropping decoded video frame at timestamp=${frame.timestamp}, no longer in queue`
        );
      }
      frame.close();
      return;
    }
    const decodingFrame = this.#decodingVideoFrames[decodingFrameIndex];
    arrayRemoveAt(this.#decodingVideoFrames, decodingFrameIndex);
    // Drop frames that are beyond current time, since we're too late to render them.
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    if (isFrameBeyondTime(decodingFrame, direction, currentTimeInMicros)) {
      if (DEBUG) {
        console.log(
          `dropping decoded video frame at timestamp=${decodingFrame.timestamp}, beyond currentTime=${currentTimeInMicros}us`
        );
      }
      frame.close();
      // Decode more frames (if we now have more space in the queue)
      this.#decodeVideoFrames();
      return;
    }
    if (DEBUG) {
      console.log(
        `decoded video frame at timestamp=${decodingFrame.timestamp}`
      );
    }
    // Note: Chrome does not yet copy EncodedVideoChunk.duration to VideoFrame.duration
    const bitmap = await createImageBitmap(
      frame as unknown as CanvasImageSource
    );
    const newFrame = new VideoFrame(bitmap, {
      timestamp: decodingFrame.timestamp,
      duration: decodingFrame.duration!
    });
    frame.close();
    frame = newFrame;
    this.#decodedVideoFrames.push(newFrame);
    if (this.#nextDecodedVideoFramePromise) {
      this.#nextDecodedVideoFramePromise.resolve();
      this.#nextDecodedVideoFramePromise = undefined;
    }
    // Schedule render immediately if this is the first decoded frame after a seek
    if (this.#lastRenderedFrame === undefined) {
      this.#scheduleRenderVideoFrame();
    }
    // Decode more frames (if we now have more space in the queue)
    this.#decodeVideoFrames();
  }

  #scheduleRenderVideoFrame() {
    if (this.#nextRenderFrame === 0) {
      this.#nextRenderFrame = requestAnimationFrame(() =>
        this.#renderVideoFrame()
      );
    }
  }

  #renderVideoFrame(): void {
    this.#nextRenderFrame = 0;
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    // Drop all frames that are before current time, since we're too late to render them.
    for (let i = this.#decodedVideoFrames.length - 1; i >= 0; i--) {
      const frame = this.#decodedVideoFrames[i];
      if (isFrameBeyondTime(frame, direction, currentTimeInMicros)) {
        frame.close();
        arrayRemoveAt(this.#decodedVideoFrames, i);
      }
    }
    // Render the frame at current time.
    let currentFrameIndex = this.#decodedVideoFrames.findIndex((frame) => {
      return (
        frame.timestamp <= currentTimeInMicros &&
        currentTimeInMicros < frame.timestamp + frame.duration!
      );
    });
    if (currentFrameIndex < 0) {
      // Decode more frames (if we now have more space in the queue)
      this.#decodeVideoFrames();
      return;
    }
    const frame = this.#decodedVideoFrames[currentFrameIndex];
    if (this.#lastRenderedFrame !== frame.timestamp) {
      if (DEBUG) {
        console.log(`render video frame timestamp=${frame.timestamp}`);
      }
      this.#updateSize(frame.displayWidth, frame.displayHeight);
      this.#canvasContext.drawImage(
        frame,
        0,
        0,
        frame.displayWidth,
        frame.displayHeight
      );
      arrayRemoveAt(this.#decodedVideoFrames, currentFrameIndex);
      this.#lastRenderedFrame = frame.timestamp;
      frame.close();
    }
    // Decode more frames (if we now have more space in the queue)
    this.#decodeVideoFrames();
  }

  #resetVideoDecoder(): void {
    for (const frame of this.#decodedVideoFrames) {
      frame.close();
    }
    this.#lastVideoDecoderConfig = undefined;
    this.#furthestDecodingVideoFrame = undefined;
    this.#lastRenderedFrame = undefined;
    this.#decodingVideoFrames.length = 0;
    this.#decodedVideoFrames.length = 0;
    this.#videoDecoder.reset();
  }

  #decodeAudio(): void {
    const mediaSource = this.#srcObject;
    if (!mediaSource) {
      return;
    }
    const audioTrackBuffer = getActiveAudioTrackBuffer(mediaSource);
    if (!audioTrackBuffer) {
      return;
    }
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    // Check if last decoded frame still exists, i.e. it was not overwritten
    // or removed from the SourceBuffer
    if (
      this.#furthestDecodedAudioFrame !== undefined &&
      !audioTrackBuffer.hasFrame(this.#furthestDecodedAudioFrame)
    ) {
      if (DEBUG) {
        console.warn(
          `last decoded audio frame was removed (timestamp=${
            this.#furthestDecodedAudioFrame.timestamp
          }), decoding from current time`
        );
      }
      this.#furthestDecodedAudioFrame = undefined;
    }
    // Decode audio for current time
    if (this.#furthestDecodedAudioFrame === undefined) {
      const frameAtTime = audioTrackBuffer.findFrameForTime(this.currentTime);
      if (frameAtTime === undefined) {
        return;
      }
      this.#processAudioDecodeQueue(
        audioTrackBuffer.getDecodeDependenciesForFrame(frameAtTime),
        direction
      );
    }
    // Decode next frames in advance
    while (
      this.#decodingAudioFrames.length + this.#decodedAudioFrames.length <
      decodeQueueLwm
    ) {
      const nextQueue = audioTrackBuffer.getNextFrames(
        this.#furthestDecodedAudioFrame!,
        decodeQueueHwm -
          (this.#decodingAudioFrames.length + this.#decodedAudioFrames.length),
        direction
      );
      if (nextQueue === undefined) {
        break;
      }
      this.#processAudioDecodeQueue(nextQueue, direction);
    }
  }

  #processAudioDecodeQueue(
    decodeQueue: AudioDecodeQueue,
    direction: Direction
  ): void {
    const { frames, codecConfig } = decodeQueue;
    if (DEBUG) {
      console.log(
        `decode audio frames: timestamp=${frames[0].timestamp} count=${frames.length}`
      );
    }
    if (
      this.#audioDecoder.state === "unconfigured" ||
      this.#lastAudioDecoderConfig !== codecConfig
    ) {
      this.#audioDecoder.configure(codecConfig);
      this.#lastAudioDecoderConfig = codecConfig;
    }
    if (direction === Direction.BACKWARD) {
      // Audio has no dependencies between frames, so we can decode them
      // in the same order as they will be rendered.
      frames.reverse();
    }
    for (const frame of frames) {
      // AudioDecoder does not always preserve EncodedAudioChunk.timestamp
      // to the decoded AudioData.timestamp, instead it adds up the sample durations
      // since the last decoded chunk. This breaks reverse playback, since we
      // intentionally feed the decoder chunks in the "wrong" order.
      // Copy to a new chunk with the same *increasing* timestamp,
      // and fix the timestamp later on.
      const newFrame = cloneEncodedAudioChunk(
        frame,
        this.#audioDecoderTimestamp
      );
      this.#originalDecodingAudioFrames.set(newFrame, frame);
      this.#audioDecoder.decode(newFrame);
      this.#decodingAudioFrames.push(newFrame);
      this.#audioDecoderTimestamp += frame.duration!;
    }
    // The "furthest audio frame" is always the last one,
    // since we decode them in rendering order (see above).
    this.#furthestDecodedAudioFrame = frames[frames.length - 1];
  }

  #onAudioData(frame: AudioData): void {
    const decodingFrameIndex = this.#decodingAudioFrames.findIndex((x) =>
      isFrameTimestampEqual(x, frame)
    );
    if (decodingFrameIndex < 0) {
      // Drop frames that are no longer in the decode queue.
      if (DEBUG) {
        console.log(
          `dropping decoded audio frame at timestamp=${frame.timestamp}, no longer in queue`
        );
      }
      frame.close();
      return;
    }
    const decodingFrame = this.#decodingAudioFrames[decodingFrameIndex];
    arrayRemoveAt(this.#decodingAudioFrames, decodingFrameIndex);
    // Restore original timestamp
    const decodedFrame = cloneAudioData(
      frame,
      this.#originalDecodingAudioFrames.get(decodingFrame)!.timestamp
    );
    frame.close();
    // Drop frames that are beyond current time, since we're too late to render them.
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    if (isFrameBeyondTime(decodedFrame, direction, currentTimeInMicros)) {
      if (DEBUG) {
        console.log(
          `dropping decoded audio frame at timestamp=${decodedFrame.timestamp}, beyond currentTime=${currentTimeInMicros}us`
        );
      }
      decodedFrame.close();
      // Decode more frames (if we now have more space in the queue)
      this.#decodeAudio();
      return;
    }
    if (DEBUG) {
      console.log(`decoded audio frame at timestamp=${decodedFrame.timestamp}`);
    }
    this.#decodedAudioFrames.push(decodedFrame);
    if (this.#nextDecodedAudioFramePromise) {
      this.#nextDecodedAudioFramePromise.resolve();
      this.#nextDecodedAudioFramePromise = undefined;
    }
    // Decode more frames (if we now have more space in the queue)
    this.#decodeAudio();
  }

  #initializeAudio(sampleRate: number): AudioContext {
    this.#audioContext = new AudioContext({
      sampleRate: sampleRate,
      latencyHint: "playback"
    });

    this.#volumeGainNode = new GainNode(this.#audioContext);
    this.#volumeGainNode.connect(this.#audioContext.destination);
    this.#updateVolume();

    if (this.#isPotentiallyPlaying() && !this.#seeking) {
      void this.#audioContext.resume();
    } else {
      void this.#audioContext.suspend();
    }

    return this.#audioContext;
  }

  #renderAudio() {
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    // Drop all frames that are before current time, since we're too late to render them.
    for (let i = this.#decodedAudioFrames.length - 1; i >= 0; i--) {
      const frame = this.#decodedAudioFrames[i];
      if (isFrameBeyondTime(frame, direction, currentTimeInMicros)) {
        frame.close();
        arrayRemoveAt(this.#decodedAudioFrames, i);
      }
    }
    // Don't render audio while playback is stopped.
    if (this.#playbackRate === 0) return;
    let nextFrameIndex: number = -1;
    if (this.#lastScheduledAudioFrameTime >= 0) {
      // Render the next frame.
      nextFrameIndex = this.#decodedAudioFrames.findIndex((frame) => {
        if (direction === Direction.BACKWARD) {
          return (
            frame.timestamp + frame.duration ===
            this.#lastScheduledAudioFrameTime
          );
        } else {
          return frame.timestamp === this.#lastScheduledAudioFrameTime;
        }
      });
    }
    if (nextFrameIndex < 0) {
      // Render the frame at current time.
      nextFrameIndex = this.#decodedAudioFrames.findIndex((frame) => {
        return (
          frame.timestamp <= currentTimeInMicros &&
          currentTimeInMicros < frame.timestamp + frame.duration
        );
      });
    }
    if (nextFrameIndex < 0) {
      // Decode more frames (if we now have more space in the queue)
      this.#decodeAudio();
      return;
    }
    // Collect as many consecutive audio frames as possible
    // to schedule in a single batch.
    const firstFrame = this.#decodedAudioFrames[nextFrameIndex];
    const frames: AudioData[] = [firstFrame];
    for (
      let frameIndex = nextFrameIndex + 1;
      frameIndex < this.#decodedAudioFrames.length;
      frameIndex++
    ) {
      const frame = this.#decodedAudioFrames[frameIndex];
      const previousFrame = frames[frames.length - 1];
      if (
        isConsecutiveAudioFrame(previousFrame, frame, direction) &&
        frame.format === firstFrame.format &&
        frame.numberOfChannels === firstFrame.numberOfChannels &&
        frame.sampleRate === firstFrame.sampleRate
      ) {
        // This frame is consecutive with the previous frame.
        frames.push(frame);
      } else {
        // This frame is not consecutive. We can't schedule this in the same batch.
        break;
      }
    }
    this.#audioContext ??= this.#initializeAudio(firstFrame.sampleRate);
    this.#renderAudioFrame(frames, currentTimeInMicros, direction);
    // Decode more frames (if we now have more space in the queue)
    this.#decodeAudio();
  }

  #renderAudioFrame(
    frames: AudioData[],
    currentTimeInMicros: number,
    direction: Direction
  ) {
    const firstFrame = frames[0];
    const lastFrame = frames[frames.length - 1];
    const firstTimestamp = firstFrame.timestamp;
    const lastTimestamp = lastFrame.timestamp + lastFrame.duration;
    if (DEBUG) {
      console.log(
        `render audio frames start=${firstTimestamp} end=${lastTimestamp} duration=${
          lastTimestamp - firstTimestamp
        } count=${frames.length}`
      );
    }
    // For reverse playback, first put the frames back in their original order,
    // so we can reverse the individual samples later.
    if (direction === Direction.BACKWARD) {
      frames.reverse();
    }
    // Create an AudioBuffer containing all frame data
    const { numberOfChannels, sampleRate } = frames[0];
    const audioBuffer = new AudioBuffer({
      numberOfChannels,
      length: sumWith(frames, (frame) => frame.numberOfFrames),
      sampleRate
    });
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const options: AudioDataCopyToOptions = {
        format: "f32-planar",
        planeIndex: channel
      };
      const destination = audioBuffer.getChannelData(channel);
      let offset = 0;
      for (const frame of frames) {
        const size =
          frame.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT;
        frame.copyTo(destination.subarray(offset, offset + size), options);
        offset += size;
      }
      if (direction === Direction.BACKWARD) {
        // For reverse playback, reverse the order of the individual samples.
        destination.reverse();
      }
    }
    // Schedule an AudioBufferSourceNode to play the AudioBuffer
    this.#scheduleAudioBuffer(
      audioBuffer,
      firstTimestamp,
      currentTimeInMicros,
      this.#playbackRate
    );
    this.#lastScheduledAudioFrameTime = lastTimestamp;
    // Close the frames, so the audio decoder can reclaim them.
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      frame.close();
      arrayRemove(this.#decodedAudioFrames, frame);
    }
  }

  #resetAudioDecoder(): void {
    for (const frame of this.#decodedAudioFrames) {
      frame.close();
    }
    for (const audioSourceNode of this.#scheduledAudioSourceNodes) {
      audioSourceNode.node.stop();
    }
    this.#lastAudioDecoderConfig = undefined;
    this.#audioDecoderTimestamp = 0;
    this.#furthestDecodedAudioFrame = undefined;
    this.#decodingAudioFrames.length = 0;
    this.#decodedAudioFrames.length = 0;
    this.#scheduledAudioSourceNodes.length = 0;
    this.#lastScheduledAudioFrameTime = -1;
    this.#audioDecoder.reset();
  }

  #updateVolume(): void {
    if (this.#volumeGainNode === undefined) return;
    this.#volumeGainNode.gain.value = this.#muted ? 0 : this.#volume;
  }

  #updateAudioPlaybackRate() {
    // Re-schedule all audio nodes with the new playback rate.
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const playbackRate = this.#playbackRate;
    for (const entry of this.#scheduledAudioSourceNodes.slice()) {
      entry.node.stop();
      this.#scheduleAudioBuffer(
        entry.node.buffer!,
        entry.timestamp,
        currentTimeInMicros,
        playbackRate
      );
    }
  }

  #scheduleAudioBuffer(
    audioBuffer: AudioBuffer,
    timestamp: number,
    currentTimeInMicros: number,
    playbackRate: number
  ): void {
    const node = this.#audioContext!.createBufferSource();
    node.buffer = audioBuffer;
    node.connect(this.#volumeGainNode!);

    const entry = { node: node, timestamp };
    this.#scheduledAudioSourceNodes.push(entry);
    node.addEventListener("ended", () => {
      arrayRemove(this.#scheduledAudioSourceNodes, entry);
    });

    const offset = (timestamp - currentTimeInMicros) / (1e6 * playbackRate);
    node.playbackRate.value = Math.abs(playbackRate);
    if (offset > 0) {
      node.start(0, offset);
    } else {
      node.start(-offset);
    }
  }

  #isPotentiallyPlaying(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#potentially-playing
    return !this.#paused && !this.#hasEndedPlayback() && !this.#isBlocked();
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
    this.#updatePlayed();
    if (previousReadyState === newReadyState) {
      return;
    }
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
      if (this.#advanceLoop === 0) {
        this.#scheduleRenderVideoFrame();
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
      if (wasPotentiallyPlaying && !this.#hasEndedPlayback()) {
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
      // Decode more frames
      this.#decodeVideoFrames();
      this.#decodeAudio();
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
    if (oldWidth !== width || oldHeight !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
      // https://html.spec.whatwg.org/multipage/media.html#concept-video-intrinsic-width
      // Whenever the intrinsic width or intrinsic height of the video changes
      // (including, for example, because the selected video track was changed),
      // if the element's readyState attribute is not HAVE_NOTHING,
      // the user agent must queue a media element task given the media element
      // to fire an event named resize at the media element.
      if (this.#readyState !== MediaReadyState.HAVE_NOTHING) {
        queueTask(() => this.dispatchEvent(new Event("resize")));
      }
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

  #notifyEndOfStream(): void {
    this.#isEndOfStream = true;
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
    notifyEndOfStream = (videoElement: BabyVideoElement) => {
      videoElement.#notifyEndOfStream();
    };
  }
}

customElements.define("baby-video", BabyVideoElement);

function isFrameBeyondTime(
  frame: EncodedChunk | AudioData | VideoFrame,
  direction: Direction,
  timeInMicros: number
): boolean {
  if (direction == Direction.FORWARD) {
    return frame.timestamp + frame.duration! <= timeInMicros;
  } else {
    return frame.timestamp >= timeInMicros;
  }
}

function getFrameTolerance(frame: EncodedChunk | AudioData | VideoFrame) {
  return Math.ceil(frame.duration! / 16);
}

function isFrameTimestampEqual(
  left: EncodedChunk,
  right: AudioData | VideoFrame
): boolean {
  // Due to rounding, there can be a small gap between encoded and decoded frames.
  return Math.abs(left.timestamp - right.timestamp) <= getFrameTolerance(left);
}

function isConsecutiveAudioFrame(
  previous: AudioData,
  next: AudioData,
  direction: Direction
): boolean {
  let diff: number;
  if (direction === Direction.BACKWARD) {
    diff = previous.timestamp - (next.timestamp + next.duration);
  } else {
    diff = next.timestamp - (previous.timestamp + previous.duration);
  }
  // Due to rounding, there can be a small gap between consecutive audio frames.
  return Math.abs(diff) <= getFrameTolerance(previous);
}

function cloneEncodedAudioChunk(
  original: EncodedAudioChunk,
  timestamp: number
): EncodedAudioChunk {
  const data = new ArrayBuffer(original.byteLength);
  original.copyTo(data);
  return new EncodedAudioChunk({
    data,
    timestamp,
    duration: original.duration ?? undefined,
    type: original.type
  });
}

function cloneAudioData(original: AudioData, timestamp: number): AudioData {
  const format = "f32-planar";
  let totalSize = 0;
  for (
    let channelIndex = 0;
    channelIndex < original.numberOfChannels;
    channelIndex++
  ) {
    totalSize +=
      original.allocationSize({ format, planeIndex: channelIndex }) /
      Float32Array.BYTES_PER_ELEMENT;
  }
  const buffer = new Float32Array(totalSize);
  let offset = 0;
  for (
    let channelIndex = 0;
    channelIndex < original.numberOfChannels;
    channelIndex++
  ) {
    const options: AudioDataCopyToOptions = {
      format,
      planeIndex: channelIndex
    };
    const channelSize =
      original.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT;
    original.copyTo(buffer.subarray(offset, offset + totalSize), options);
    offset += channelSize;
  }
  return new AudioData({
    data: buffer,
    format,
    numberOfChannels: original.numberOfChannels,
    numberOfFrames: original.numberOfFrames,
    sampleRate: original.sampleRate,
    timestamp: timestamp
  });
}
