import stylesheet from "./style.css";
import {
  attachToMediaElement,
  BabyMediaSource,
  detachFromMediaElement,
  getActiveVideoTrackBuffer,
  getBuffered,
} from "./media-source";
import { Deferred, queueTask } from "./util";
import { TimeRanges } from "./time-ranges";
import { Sample } from "mp4box";

const template = document.createElement("template");
template.innerHTML = `<style>${stylesheet}</style>`;

export enum MediaReadyState {
  HAVE_NOTHING,
  HAVE_METADATA,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_ENOUGH_DATA,
}

export let updateDuration: (videoElement: BabyVideoElement) => void;
export let updateReadyState: (
  videoElement: BabyVideoElement,
  newReadyState: MediaReadyState
) => void;

export class BabyVideoElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement;
  readonly #canvasContext: CanvasRenderingContext2D;

  #currentTime: number = 0;
  #ended: boolean = false;
  #paused: boolean = true;
  #readyState: MediaReadyState = 0;
  #srcObject: BabyMediaSource | undefined;

  #pendingPlayPromises: Array<Deferred<void>> = [];
  #advanceLoop: number = 0;
  #lastAdvanceTime: number = 0;

  readonly #videoDecoder: VideoDecoder;
  #lastDecodedVideoSample: Sample | undefined;
  #pendingVideoFrame: VideoFrame | undefined;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(template.content.cloneNode(true));

    this.#canvas = document.createElement("canvas");
    this.#canvas.width = 1920;
    this.#canvas.height = 1080;
    this.#canvas.style.width = "100%";
    this.#canvas.style.aspectRatio = "16 / 9";
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
    this.#currentTime = value;
    this.#render();
    this.#updatePlaying();
  }

  get duration(): number {
    if (!this.#srcObject) {
      return NaN;
    }
    return this.#srcObject.duration;
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

  get srcObject(): BabyMediaSource | undefined {
    return this.#srcObject;
  }

  set srcObject(srcObject: BabyMediaSource | undefined) {
    if (this.#srcObject) {
      detachFromMediaElement(this.#srcObject);
    }
    this.#srcObject = srcObject;
    if (srcObject) {
      attachToMediaElement(srcObject, this);
    }
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
      this.currentTime = 0;
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
      const currentPlaybackPosition = this.#getCurrentPlaybackPosition(
        performance.now()
      );
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
        this.#currentTime = currentPlaybackPosition;
        this.#render();
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
      return this.#currentTime + (now - this.#lastAdvanceTime) / 1000;
    } else {
      return this.#currentTime;
    }
  }

  #advanceCurrentTime(now: number): void {
    this.#currentTime = this.#getCurrentPlaybackPosition(now);
    this.#lastAdvanceTime = now;
    this.#render();
    if (this.#isPotentiallyPlaying()) {
      this.#advanceLoop = requestAnimationFrame((now) =>
        this.#advanceCurrentTime(now)
      );
    }
  }

  #render(): void {
    const mediaSource = this.#srcObject;
    if (!mediaSource) {
      return;
    }
    const videoTrackBuffer = getActiveVideoTrackBuffer(mediaSource);
    if (!videoTrackBuffer) {
      return;
    }
    if (this.#videoDecoder.state === "unconfigured") {
      this.#videoDecoder.configure(videoTrackBuffer.codecConfig);
    }
    const sampleAtTime = videoTrackBuffer.findSampleForTime(this.currentTime);
    if (sampleAtTime && this.#lastDecodedVideoSample !== sampleAtTime) {
      const decodeQueue = videoTrackBuffer.getDecodeQueueForSample(
        sampleAtTime,
        this.#lastDecodedVideoSample
      );
      for (const sample of decodeQueue) {
        this.#videoDecoder.decode(
          new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: (1e6 * sample.cts) / sample.timescale,
            duration: (1e6 * sample.duration) / sample.timescale,
            data: sample.data,
          })
        );
        this.#lastDecodedVideoSample = sample;
      }
    }
  }

  #onVideoFrame(frame: VideoFrame): void {
    if (this.#pendingVideoFrame) {
      this.#pendingVideoFrame.close();
    } else {
      requestAnimationFrame(() => this.#renderVideoFrame());
    }
    this.#pendingVideoFrame = frame;
  }

  #renderVideoFrame(): void {
    const frame = this.#pendingVideoFrame;
    if (!frame) {
      return;
    }
    this.#canvas.width = frame.displayWidth;
    this.#canvas.height = frame.displayHeight;
    this.#canvasContext.drawImage(
      frame,
      0,
      0,
      frame.displayWidth,
      frame.displayHeight
    );
    frame.close();
    this.#pendingVideoFrame = undefined;
  }

  #isPotentiallyPlaying(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#potentially-playing
    return !this.#paused && !this.#ended && !this.#isBlocked();
  }

  #isBlocked(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#blocked-media-element
    return this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA;
  }

  #updateReadyState(newReadyState: MediaReadyState): void {
    this.#readyState = newReadyState;
    // TODO https://html.spec.whatwg.org/multipage/media.html#ready-states
    this.#updatePlaying();
  }

  static {
    updateDuration = (videoElement: BabyVideoElement) => {
      queueTask(() => videoElement.dispatchEvent(new Event("durationchange")));
      const newDuration = videoElement.duration;
      if (videoElement.currentTime > newDuration) {
        videoElement.currentTime = newDuration;
      }
    };
    updateReadyState = (
      videoElement: BabyVideoElement,
      newReadyState: MediaReadyState
    ) => {
      videoElement.#updateReadyState(newReadyState);
    };
  }
}

customElements.define("baby-video", BabyVideoElement);
