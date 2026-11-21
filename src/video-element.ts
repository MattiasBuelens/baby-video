import stylesheet from "./style.css?inline";
import { BabyMediaSource } from "./media-source";
import { Deferred, queueTask } from "./util";
import { TimeRange, TimeRanges } from "./time-ranges";
import { MediaReadyState } from "./media-source-attachment";
import type {
  MediaPipelineAudioOutputInit,
  MediaPipelineError,
  MediaPipelineHost,
  PresentedVideoFrame
} from "./media-pipeline";
import { MediaPipelineEndpoint } from "./media-pipeline-endpoint";
import { MediaPipelineProxy } from "./media-pipeline-proxy";
import type { BabyMediaSourceHandle } from "./media-source-handle";
import { BabyVideoPlaybackQuality } from "./video-playback-quality";
import { BabyMediaError } from "./media-error";

// Ports of handles that were already attached to an element.
// A handle can only be used once.
const usedHandlePorts = new WeakSet<MessagePort>();
import { AudioOutput } from "./audio-output";

// https://wicg.github.io/video-rvfc/#video-rvfc-methods
// The document's video frame request callback identifier.
// (There's only one document.)
let videoFrameRequestCallbackIdentifier = 0;

const template = document.createElement("template");
template.innerHTML = `<style>${stylesheet}</style>`;

// Internal accessors for BabyVideoElementPipelineHost.
let getPipelineHost: (
  element: BabyVideoElement
) => MediaPipelineHost | undefined;
let updateReadyState: (
  element: BabyVideoElement,
  readyState: MediaReadyState
) => void;
let updateDuration: (element: BabyVideoElement, duration: number) => void;
let notifyProgress: (element: BabyVideoElement) => void;
let notifyEndOfStream: (element: BabyVideoElement) => void;
let notifyStreamReopened: (element: BabyVideoElement) => void;
let onTimeUpdate: (
  element: BabyVideoElement,
  currentTime: number,
  isNormalPlayback: boolean
) => void;
let onSeekComplete: (element: BabyVideoElement) => void;
let updateSize: (
  element: BabyVideoElement,
  width: number,
  height: number
) => void;
let onVideoFramePresented: (
  element: BabyVideoElement,
  frame: PresentedVideoFrame
) => void;
let onVideoFramesDropped: (
  element: BabyVideoElement,
  droppedFrames: number
) => void;
let onPipelineError: (
  element: BabyVideoElement,
  error: MediaPipelineError,
  message: string
) => void;
let createAudioOutput: (
  element: BabyVideoElement,
  init: MediaPipelineAudioOutputInit
) => void;

// https://html.spec.whatwg.org/multipage/media.html#dom-media-networkstate
const enum NetworkState {
  NETWORK_EMPTY = 0,
  NETWORK_IDLE = 1,
  NETWORK_LOADING = 2,
  NETWORK_NO_SOURCE = 3
}

// A task queued on the media element event task source.
// https://html.spec.whatwg.org/multipage/media.html#queue-a-media-element-task
class MediaElementTask {
  readonly steps: () => void;
  // For a task that would resolve or reject pending play promises: settles
  // those promises, without running the rest of the task.
  readonly settlePlayPromises: (() => void) | undefined;

  constructor(steps: () => void, settlePlayPromises?: () => void) {
    this.steps = steps;
    this.settlePlayPromises = settlePlayPromises;
  }
}

// A partial re-implementation of the HTML <video> element.
//
// This class implements the HTML media element state machine: its attributes,
// events and play promises. Everything that actually plays media (decoding,
// rendering and the playback clock) lives in the MediaPipeline, which reports
// back through MediaPipelineHost.
export class BabyVideoElement extends HTMLElement {
  // https://html.spec.whatwg.org/multipage/media.html#htmlmediaelement
  static readonly NETWORK_EMPTY = 0;
  static readonly NETWORK_IDLE = 1;
  static readonly NETWORK_LOADING = 2;
  static readonly NETWORK_NO_SOURCE = 3;
  static readonly HAVE_NOTHING = 0;
  static readonly HAVE_METADATA = 1;
  static readonly HAVE_CURRENT_DATA = 2;
  static readonly HAVE_FUTURE_DATA = 3;
  static readonly HAVE_ENOUGH_DATA = 4;

  declare readonly NETWORK_EMPTY: 0;
  declare readonly NETWORK_IDLE: 1;
  declare readonly NETWORK_LOADING: 2;
  declare readonly NETWORK_NO_SOURCE: 3;
  declare readonly HAVE_NOTHING: 0;
  declare readonly HAVE_METADATA: 1;
  declare readonly HAVE_CURRENT_DATA: 2;
  declare readonly HAVE_FUTURE_DATA: 3;
  declare readonly HAVE_ENOUGH_DATA: 4;

  #canvas: HTMLCanvasElement;
  // Whether #canvas has transferred control to an OffscreenCanvas.
  #canvasTransferred: boolean = false;

  #currentTime: number = 0;
  #duration: number = NaN;
  #ended: boolean = false;
  #error: BabyMediaError | null = null;
  // https://html.spec.whatwg.org/multipage/media.html#default-playback-start-position
  #defaultPlaybackStartPosition: number = 0;
  #defaultPlaybackRate: number = 1;
  // https://html.spec.whatwg.org/multipage/media.html#can-autoplay-flag
  #canAutoplay: boolean = true;
  // https://html.spec.whatwg.org/multipage/media.html#show-poster-flag
  // When a media element is created, this flag must be set to true.
  #showPoster: boolean = true;
  // Whether the muted content attribute was applied, see connectedCallback().
  #initializedMuted: boolean = false;
  readonly #poster: HTMLImageElement;
  readonly #dimensionsStyle: HTMLStyleElement;
  #networkState: NetworkState = NetworkState.NETWORK_EMPTY;
  // Tasks queued on the media element event task source that haven't run yet.
  // The media element load algorithm discards them.
  #pendingTasks: Set<MediaElementTask> = new Set();
  // Aborts the running instance of the resource selection algorithm,
  // see the media element load algorithm.
  #resourceSelectionAbortController: AbortController = new AbortController();
  #muted: boolean = false;
  #paused: boolean = true;
  #playbackRate: number = 1;
  #played: TimeRanges = new TimeRanges([]);
  #readyState: MediaReadyState = MediaReadyState.HAVE_NOTHING;
  #seeking: boolean = false;
  #srcObject: BabyMediaSource | BabyMediaSourceHandle | undefined;
  #volume: number = 1;
  #videoWidth: number;
  #videoHeight: number;

  #pendingPlayPromises: Array<Deferred<void>> = [];
  #lastPlayedTime: number = NaN;
  #lastTimeUpdate: number = 0;
  #lastProgress: number = 0;
  #nextProgressTimer: number = 0;
  #hasFiredLoadedData: boolean = false;
  #isEndOfStream: boolean = false;

  #pipeline: MediaPipelineProxy | undefined;
  // The pipeline's end of the port, if the pipeline is on the main thread.
  #pipelineEndpoint: MediaPipelineEndpoint | undefined;
  #pipelineHost: MediaPipelineHost | undefined;
  #audioOutput: AudioOutput | undefined;
  #audioOutputPlaying: boolean = false;

  // https://wicg.github.io/video-rvfc/#video-rvfc-methods
  #videoFrameRequestCallbacks: Map<number, VideoFrameRequestCallback> =
    new Map();
  #lastPresentedFrameIdentifier: number = 0;
  // The number of frames presented for composition. Unlike the total video
  // frame count, this never resets, since presentedFrames MUST be
  // monotonically increasing.
  #presentedFrames: number = 0;
  #latestPresentedFrame: VideoFrameCallbackMetadata | undefined;
  #videoFrameCallbacksAnimationFrame: number = 0;

  // https://w3c.github.io/media-playback-quality/#concepts
  #totalVideoFrameCount: number = 0;
  #droppedVideoFrameCount: number = 0;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(template.content.cloneNode(true));

    // The default object size is a width of 300 CSS pixels and a height of 150 CSS pixels.
    this.#videoWidth = 300;
    this.#videoHeight = 150;
    this.#canvas = this.#createCanvas();
    shadow.appendChild(this.#canvas);
    // https://html.spec.whatwg.org/multipage/media.html#attr-video-poster
    // The poster frame is shown on top of the canvas. In a worker, the canvas
    // is controlled by an OffscreenCanvas, so we couldn't draw it there.
    this.#poster = document.createElement("img");
    this.#poster.className = "poster";
    this.#poster.alt = "";
    this.#poster.hidden = true;
    shadow.appendChild(this.#poster);
    // The width and height content attributes, see #updateDimensions().
    this.#dimensionsStyle = document.createElement("style");
    shadow.appendChild(this.#dimensionsStyle);

    const canvasContext = this.#canvas.getContext("2d")!;
    canvasContext.fillStyle = "black";
    canvasContext.fillRect(0, 0, this.#canvas.width, this.#canvas.height);

    // Safari 16.4 to 18 have VideoDecoder, but not AudioDecoder.
    // There is no fallback to play without audio, so we need both.
    if (
      typeof VideoDecoder !== "function" ||
      typeof AudioDecoder !== "function"
    ) {
      throw new Error(`<baby-video>: This browser does not support WebCodecs.`);
    }
  }

  #createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 150;
    return canvas;
  }

  // Replaces our canvas with a fresh one.
  #replaceCanvas(): HTMLCanvasElement {
    const canvas = this.#createCanvas();
    this.#canvas.replaceWith(canvas);
    this.#canvas = canvas;
    this.#canvasTransferred = false;
    return canvas;
  }

  // Gives a media pipeline on the main thread our canvas to render to.
  #getCanvas(): HTMLCanvasElement {
    // A canvas that transferred control to an OffscreenCanvas
    // can no longer be drawn to from here.
    return this.#canvasTransferred ? this.#replaceCanvas() : this.#canvas;
  }

  // Gives a media pipeline in a worker a canvas to render to.
  // Once a canvas has transferred control to an OffscreenCanvas,
  // it cannot be transferred again, so always start from a fresh one.
  #transferCanvas(): OffscreenCanvas {
    const offscreen = this.#replaceCanvas().transferControlToOffscreen();
    this.#canvasTransferred = true;
    return offscreen;
  }

  connectedCallback(): void {
    // Consider checking for properties that may have been set
    // before the element upgraded.
    // https://web.dev/custom-elements-best-practices/
    // https://html.spec.whatwg.org/multipage/media.html#attr-media-muted
    // When a media element is created, if the element has a muted content attribute specified,
    // then the muted IDL attribute should be set to true.
    // (A custom element can't see its attributes in its constructor,
    // so do this when it's first connected.)
    if (!this.#initializedMuted) {
      this.#initializedMuted = true;
      if (this.hasAttribute("muted")) {
        this.#muted = true;
        this.#updateVolume();
      }
    }
    this.#upgradeProperty("srcObject");
    this.#upgradeProperty("autoplay");
    this.#upgradeProperty("loop");
    this.#upgradeProperty("poster");
    this.#upgradeProperty("defaultMuted");
    this.#upgradeProperty("defaultPlaybackRate");
    this.#upgradeProperty("muted");
    this.#upgradeProperty("playbackRate");
    this.#upgradeProperty("volume");
    this.#upgradeProperty("currentTime");
  }

  static get observedAttributes(): string[] {
    return ["poster", "width", "height"];
  }

  attributeChangedCallback(name: string): void {
    if (name === "poster") {
      this.#updatePosterSource();
    } else if (name === "width" || name === "height") {
      this.#updateDimensions();
    }
  }

  // region Content attributes

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-autoplay
  get autoplay(): boolean {
    return this.hasAttribute("autoplay");
  }

  set autoplay(value: boolean) {
    this.toggleAttribute("autoplay", Boolean(value));
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-loop
  get loop(): boolean {
    return this.hasAttribute("loop");
  }

  set loop(value: boolean) {
    this.toggleAttribute("loop", Boolean(value));
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-defaultmuted
  // Reflects the muted content attribute.
  get defaultMuted(): boolean {
    return this.hasAttribute("muted");
  }

  set defaultMuted(value: boolean) {
    this.toggleAttribute("muted", Boolean(value));
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-video-poster
  // Reflects the poster content attribute, as a URL.
  get poster(): string {
    const value = this.getAttribute("poster");
    if (value === null) {
      return "";
    }
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return value;
    }
  }

  set poster(value: string) {
    this.setAttribute("poster", String(value));
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-video-playsinline
  get playsInline(): boolean {
    return this.hasAttribute("playsinline");
  }

  set playsInline(value: boolean) {
    this.toggleAttribute("playsinline", Boolean(value));
  }

  // https://html.spec.whatwg.org/multipage/embedded-content-other.html#dom-dim-width
  get width(): number {
    return parseDimension(this.getAttribute("width")) ?? 0;
  }

  set width(value: number) {
    this.setAttribute("width", String(value >>> 0));
  }

  // https://html.spec.whatwg.org/multipage/embedded-content-other.html#dom-dim-height
  get height(): number {
    return parseDimension(this.getAttribute("height")) ?? 0;
  }

  set height(value: number) {
    this.setAttribute("height", String(value >>> 0));
  }

  // https://html.spec.whatwg.org/multipage/rendering.html#attributes-for-embedded-content-and-images
  // The width and height attributes map to the dimension properties width and height on the element.
  // Like presentational hints, author styles on the element override them.
  #updateDimensions(): void {
    const width = parseDimension(this.getAttribute("width"));
    const height = parseDimension(this.getAttribute("height"));
    const declarations = [
      width !== undefined ? `width: ${width}px;` : "",
      height !== undefined ? `height: ${height}px;` : ""
    ].join(" ");
    this.#dimensionsStyle.textContent = declarations
      ? `:host { ${declarations} }`
      : "";
  }

  // endregion

  // region Poster frame

  // https://html.spec.whatwg.org/multipage/media.html#poster-frame
  #updatePosterSource(): void {
    // If element's poster attribute's value is the empty string or if the attribute is absent:
    // there is no poster frame.
    const poster = this.getAttribute("poster");
    if (poster === null || poster === "") {
      this.#poster.removeAttribute("src");
    } else {
      // The image resolves the URL relative to the document, and fetches it.
      this.#poster.src = poster;
    }
    this.#updatePosterVisibility();
  }

  // https://html.spec.whatwg.org/multipage/media.html#the-video-element (rendering)
  #updatePosterVisibility(): void {
    const hasPoster = this.#poster.hasAttribute("src");
    // When no video data is available (the element's readyState attribute is either HAVE_NOTHING,
    // or HAVE_METADATA but no video data has yet been obtained at all, ...):
    //   The video element represents its poster frame, if any.
    // When the video element is paused, the current playback position is the first frame of video,
    // and the element's show poster flag is set:
    //   The video element represents its poster frame, if any, or else the first frame of the video.
    const noVideoData = !this.#hasFiredLoadedData;
    const showPosterWhilePaused = this.#paused && this.#showPoster;
    this.#poster.hidden = !(
      hasPoster &&
      (noVideoData || showPosterWhilePaused)
    );
  }

  #setShowPoster(showPoster: boolean): void {
    this.#showPoster = showPoster;
    this.#updatePosterVisibility();
  }

  // endregion

  #upgradeProperty(prop: keyof this) {
    if (this.hasOwnProperty(prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  get buffered(): TimeRanges {
    return this.#pipeline ? this.#pipeline.buffered : new TimeRanges([]);
  }

  get currentTime(): number {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-currenttime
    // The currentTime attribute must, on getting, return the media element's default playback start position,
    // unless that is zero, in which case it must return the element's official playback position.
    return this.#defaultPlaybackStartPosition !== 0
      ? this.#defaultPlaybackStartPosition
      : this.#currentTime;
  }

  set currentTime(value: number) {
    value = Number(value);
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-currenttime
    // On setting, if the media element's readyState is HAVE_NOTHING,
    // then it must set the media element's default playback start position to the new value;
    // otherwise, it must set the official playback position to the new value and then seek to the new value.
    if (this.#readyState === MediaReadyState.HAVE_NOTHING) {
      this.#defaultPlaybackStartPosition = value;
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
    this.#playbackRate = value;
    // The pipeline settles on the current playback position at the old rate,
    // and reports it back through #onTimeUpdate().
    this.#pipeline?.setPlaybackRate(value);
    this.#updatePlaying();
    this.#updatePlayed();
    this.dispatchEvent(new Event("ratechange"));
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-defaultplaybackrate
  get defaultPlaybackRate(): number {
    return this.#defaultPlaybackRate;
  }

  set defaultPlaybackRate(value: number) {
    value = Number(value);
    if (value === this.#defaultPlaybackRate) {
      return;
    }
    this.#defaultPlaybackRate = value;
    // When the defaultPlaybackRate or playbackRate attributes change value, the user agent must
    // queue a media element task given the media element to fire an event named ratechange at the media element.
    this.#queueMediaElementTask(() =>
      this.dispatchEvent(new Event("ratechange"))
    );
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

  get srcObject(): BabyMediaSource | BabyMediaSourceHandle | undefined {
    return this.#srcObject;
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject
  // Accepts a BabyMediaSource on the main thread, or a BabyMediaSourceHandle
  // of a BabyMediaSource in a dedicated worker.
  // https://w3c.github.io/media-source/#mediasource-attach
  set srcObject(
    srcObject: BabyMediaSource | BabyMediaSourceHandle | undefined | null
  ) {
    srcObject ??= undefined;
    if (
      srcObject !== undefined &&
      !(srcObject instanceof BabyMediaSource) &&
      !(srcObject.port instanceof MessagePort)
    ) {
      throw new TypeError(
        "srcObject must be a BabyMediaSource or a BabyMediaSourceHandle"
      );
    }
    // On setting, it must set the element's assigned media provider object to the new value,
    // and then invoke the element's media element load algorithm.
    this.#srcObject = srcObject;
    this.#mediaElementLoadAlgorithm();
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-error
  get error(): BabyMediaError | null {
    return this.#error;
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-networkstate
  get networkState(): number {
    return this.#networkState;
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-load
  load(): void {
    // The load() method steps are to invoke the media element load algorithm.
    this.#mediaElementLoadAlgorithm();
  }

  // https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm
  #mediaElementLoadAlgorithm(): void {
    // 1. Set this element's is currently stalled to false.
    // (We don't track stalls.)
    // 2. Abort any already-running instance of the resource selection algorithm for this element.
    this.#resourceSelectionAbortController.abort();
    this.#resourceSelectionAbortController = new AbortController();
    // 3. Let pending tasks be a list of all tasks from the media element's media element event task source
    //    in one of the task queues.
    // 4. For each task in pending tasks that would resolve pending play promises or reject pending play promises,
    //    immediately resolve or reject those promises in the order the corresponding tasks were queued.
    // 5. Remove each task in pending tasks from its task queue.
    this.#discardPendingTasks();
    // 6. If the media element's networkState is set to NETWORK_LOADING or NETWORK_IDLE,
    //    queue a media element task given the media element to fire an event named abort at the media element.
    if (
      this.#networkState === NetworkState.NETWORK_LOADING ||
      this.#networkState === NetworkState.NETWORK_IDLE
    ) {
      this.#queueMediaElementTask(() => this.dispatchEvent(new Event("abort")));
    }
    // 7. If the media element's networkState is not set to NETWORK_EMPTY, then:
    if (this.#networkState !== NetworkState.NETWORK_EMPTY) {
      // 7.1. Queue a media element task given the media element to fire an event named emptied at the media element.
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("emptied"))
      );
      // 7.2. If a fetching process is in progress for the media element, the user agent should stop it.
      // 7.3. If the media element's assigned media provider object is a MediaSource object, then detach it.
      this.#detachPipeline();
      // 7.4. Forget the media element's media-resource-specific tracks.
      // 7.5. If readyState is not set to HAVE_NOTHING, then set it to that state.
      this.#readyState = MediaReadyState.HAVE_NOTHING;
      // 7.6. If the paused attribute is false, then:
      if (!this.#paused) {
        // 7.6.1. Set the paused attribute to true.
        this.#paused = true;
        // 7.6.2. Take pending play promises and reject pending play promises with the result
        //        and an "AbortError" DOMException.
        const error = new DOMException(
          "Aborted by loading a new media resource",
          "AbortError"
        );
        this.#takePendingPlayPromises().forEach((deferred) =>
          deferred.reject(error)
        );
      }
      // 7.7. If seeking is true, set it to false.
      this.#seeking = false;
      // 7.8. Set the current playback position to 0.
      //      Set the official playback position to 0.
      //      If this changed the official playback position, then queue a media element task given the media element
      //      to fire an event named timeupdate at the media element.
      if (this.#currentTime !== 0) {
        this.#currentTime = 0;
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("timeupdate"))
        );
      }
      // 7.9. Set the timeline offset to Not-a-Number (NaN).
      // 7.10. Update the duration attribute to Not-a-Number (NaN).
      this.#duration = NaN;
    }
    // Reset everything else that belongs to the previous media resource.
    // (With a networkState of NETWORK_EMPTY, there was no media resource,
    // so most of this is already reset.)
    this.#hasFiredLoadedData = false;
    this.#ended = false;
    this.#played = new TimeRanges([]);
    this.#isEndOfStream = false;
    this.#lastProgress = 0;
    this.#lastPlayedTime = NaN;
    clearTimeout(this.#nextProgressTimer);
    this.#lastTimeUpdate = 0;
    // https://w3c.github.io/media-playback-quality/#concepts
    // The total and dropped video frame counts are reset to 0
    // when the media element load algorithm is invoked.
    this.#totalVideoFrameCount = 0;
    this.#droppedVideoFrameCount = 0;
    // There's no frame from the new source yet.
    this.#latestPresentedFrame = undefined;
    // 8. Set the playbackRate attribute to the value of the defaultPlaybackRate attribute.
    if (this.#playbackRate !== this.#defaultPlaybackRate) {
      this.#playbackRate = this.#defaultPlaybackRate;
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("ratechange"))
      );
    }
    // 9. Set the error attribute to null and the can autoplay flag to true.
    this.#error = null;
    this.#canAutoplay = true;
    // 10. Invoke the media element's resource selection algorithm.
    this.#resourceSelectionAlgorithm();
  }

  // Detaches the media pipeline (and with it, the MediaSource), if any.
  #detachPipeline(): void {
    this.#pipeline?.detach();
    this.#pipeline = undefined;
    this.#pipelineEndpoint?.detach();
    this.#pipelineEndpoint = undefined;
    this.#pipelineHost = undefined;
    this.#audioOutput?.close();
    this.#audioOutput = undefined;
    this.#audioOutputPlaying = false;
  }

  // https://html.spec.whatwg.org/multipage/media.html#concept-media-load-algorithm
  #resourceSelectionAlgorithm(): void {
    // 1. Set the element's networkState attribute to the NETWORK_NO_SOURCE value.
    this.#networkState = NetworkState.NETWORK_NO_SOURCE;
    // 2. Set the element's show poster flag to true.
    this.#setShowPoster(true);
    // 3. Await a stable state, allowing the task that invoked this algorithm to continue.
    //    The synchronous section consists of all the remaining steps of this algorithm
    //    until the algorithm says the synchronous section has ended.
    const signal = this.#resourceSelectionAbortController.signal;
    queueMicrotask(() => {
      if (signal.aborted) {
        // The media element load algorithm aborted us.
        return;
      }
      // 6. ⌛ If the media element's assigned media provider object is not null, then set mode to object.
      const srcObject = this.#srcObject;
      if (srcObject === undefined) {
        // 6. ⌛ Otherwise: (We don't support the src attribute or source children.)
        // 6.1. ⌛ Set the networkState to NETWORK_EMPTY.
        this.#networkState = NetworkState.NETWORK_EMPTY;
        // 6.3. End the synchronous section and return.
        return;
      }
      // 7. ⌛ Set the media element's networkState to NETWORK_LOADING.
      this.#networkState = NetworkState.NETWORK_LOADING;
      // 8. ⌛ Queue a media element task given the media element to fire an event named loadstart at the media element.
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("loadstart"))
      );
      // 9. Run the appropriate steps from the following list:
      //    If mode is object:
      //    1. ⌛ Set the currentSrc attribute to the empty string.
      //    2. End the synchronous section, continuing the remaining steps in parallel.
      //    3. Run the resource fetch algorithm with the assigned media provider object.
      this.#resourceFetchAlgorithm(srcObject);
    });
  }

  // https://html.spec.whatwg.org/multipage/media.html#concept-media-load-resource
  // With a MediaSource, this attaches it to the media element.
  // https://w3c.github.io/media-source/#mediasource-attach
  #resourceFetchAlgorithm(
    srcObject: BabyMediaSource | BabyMediaSourceHandle
  ): void {
    // If the media provider object is a MediaSourceHandle whose underlying MediaSource's
    // [[has ever been attached]] internal slot is true:
    //   Run the "If the media data cannot be fetched at all, due to network errors, causing the user agent
    //   to give up trying to fetch the resource" steps of the resource fetch algorithm's media data processing steps list.
    if (
      !(srcObject instanceof BabyMediaSource) &&
      usedHandlePorts.has(srcObject.port)
    ) {
      this.#mediaDataCannotBeFetched(
        "This BabyMediaSourceHandle was already used"
      );
      return;
    }
    this.#pipelineHost = new BabyVideoElementPipelineHost(this);
    // The element only ever talks to the pipeline through a message port.
    // The pipeline lives next to the MediaSource.
    if (srcObject instanceof BabyMediaSource) {
      // The MediaSource is right here, on the main thread,
      // so the pipeline can render to our own canvas directly.
      const { port1, port2 } = new MessageChannel();
      this.#pipelineEndpoint = new MediaPipelineEndpoint(srcObject, port2);
      this.#pipelineEndpoint.attach(this.#getCanvas(), this.#playbackRate);
      this.#pipeline = new MediaPipelineProxy(port1, this.#pipelineHost);
    } else {
      // The MediaSource is in a worker, at the other end of the handle's port.
      usedHandlePorts.add(srcObject.port);
      this.#pipeline = new MediaPipelineProxy(
        srcObject.port,
        this.#pipelineHost
      );
      this.#pipeline.attach(this.#transferCanvas(), this.#playbackRate);
    }
  }

  // https://html.spec.whatwg.org/multipage/media.html#media-data-processing-steps-list
  // The pipeline stopped because of a fatal error.
  #onPipelineError(error: MediaPipelineError, message: string): void {
    if (error === "unsupported") {
      // The MediaSource could not be attached, so there's nothing to detach.
      // (Otherwise, the pipeline would report the buffered ranges of
      // a MediaSource that's attached to another element.)
      this.#detachPipeline();
      this.#mediaDataCannotBeFetched(message);
    } else if (this.#readyState === MediaReadyState.HAVE_NOTHING) {
      // https://w3c.github.io/media-source/#end-of-stream-algorithm
      // If the HTMLMediaElement's readyState attribute equals HAVE_NOTHING:
      //   Run the "If the media data cannot be fetched at all" steps (for "network"), or
      //   the "If the media data can be fetched but is found by inspection to be in an unsupported format" steps
      //   (for "decode").
      this.#mediaDataCannotBeFetched(message);
    } else {
      // If the HTMLMediaElement's readyState attribute is greater than HAVE_NOTHING:
      //   Run the "If the connection is interrupted after some media data has been received" steps (for "network"),
      //   or the "If the media data is corrupted" steps (for "decode").
      this.#fatalMediaDataError(
        error === "network"
          ? BabyMediaError.MEDIA_ERR_NETWORK
          : BabyMediaError.MEDIA_ERR_DECODE,
        message
      );
    }
  }

  // https://html.spec.whatwg.org/multipage/media.html#media-data-processing-steps-list
  // "If the media data cannot be fetched at all, due to network errors, causing the user agent to give up
  //  trying to fetch the resource", and "If the media data can be fetched but is found by inspection to be
  //  in an unsupported format, or can otherwise not be rendered at all":
  #mediaDataCannotBeFetched(message: string): void {
    // 1. The user agent should cancel the fetching process.
    // 2. Abort this subalgorithm, returning to the resource selection algorithm.
    // https://html.spec.whatwg.org/multipage/media.html#concept-media-load-algorithm
    // 9. If mode is object:
    // 4. Failed with media provider: Reaching this step indicates that the media resource failed to load.
    //    Take pending play promises and queue a media element task given the media element
    //    to run the dedicated media source failure steps with the result.
    const promises = this.#takePendingPlayPromises();
    const error = new DOMException(message, "NotSupportedError");
    this.#queueMediaElementTask(
      () => this.#dedicatedMediaSourceFailureSteps(promises, message),
      () => promises.forEach((deferred) => deferred.reject(error))
    );
  }

  // https://html.spec.whatwg.org/multipage/media.html#dedicated-media-source-failure-steps
  #dedicatedMediaSourceFailureSteps(
    promises: Array<Deferred<void>>,
    message: string
  ): void {
    // 1. Set the error attribute to the result of creating a MediaError with MEDIA_ERR_SRC_NOT_SUPPORTED.
    this.#error = new BabyMediaError(
      BabyMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
      message
    );
    // 2. Forget the media element's media-resource-specific tracks.
    // 3. Set the element's networkState attribute to the NETWORK_NO_SOURCE value.
    this.#networkState = NetworkState.NETWORK_NO_SOURCE;
    // 4. Set the element's show poster flag to true.
    this.#setShowPoster(true);
    // 5. Fire an event named error at the media element.
    this.dispatchEvent(new Event("error"));
    // 6. Reject pending play promises with promises and a "NotSupportedError" DOMException.
    const error = new DOMException(message, "NotSupportedError");
    promises.forEach((deferred) => deferred.reject(error));
    // 7. Set the element's delaying-the-load-event flag to false.
  }

  // https://html.spec.whatwg.org/multipage/media.html#media-data-processing-steps-list
  // "If the connection is interrupted after some media data has been received, causing the user agent to give up
  //  trying to fetch the resource", and "If the media data is corrupted":
  #fatalMediaDataError(code: number, message: string): void {
    // 1. The user agent should cancel the fetching process.
    // (The pipeline already stopped.)
    // 2. Set the error attribute to the result of creating a MediaError with MEDIA_ERR_NETWORK (or MEDIA_ERR_DECODE).
    this.#error = new BabyMediaError(code, message);
    // 3. Set the element's networkState attribute to the NETWORK_IDLE value.
    this.#networkState = NetworkState.NETWORK_IDLE;
    // 4. Set the element's delaying-the-load-event flag to false.
    // 5. Fire an event named error at the media element.
    this.dispatchEvent(new Event("error"));
    // 6. Abort the overall resource selection algorithm.
    // (The pipeline stays attached, but won't report anything anymore.)
  }

  // https://html.spec.whatwg.org/multipage/media.html#queue-a-media-element-task
  #queueMediaElementTask(
    steps: () => void,
    settlePlayPromises?: () => void
  ): void {
    const task = new MediaElementTask(steps, settlePlayPromises);
    this.#pendingTasks.add(task);
    queueTask(() => {
      // Skip tasks that the media element load algorithm removed.
      if (this.#pendingTasks.delete(task)) {
        task.steps();
      }
    });
  }

  // https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm (steps 3 to 5)
  #discardPendingTasks(): void {
    // A Set iterates in insertion order, i.e. in the order the tasks were queued.
    const pendingTasks = [...this.#pendingTasks];
    this.#pendingTasks.clear();
    for (const task of pendingTasks) {
      task.settlePlayPromises?.();
    }
  }

  get videoWidth(): number {
    return this.#videoWidth;
  }

  get videoHeight(): number {
    return this.#videoHeight;
  }

  // https://wicg.github.io/video-rvfc/#dom-htmlvideoelement-requestvideoframecallback
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    if (typeof callback !== "function") {
      throw new TypeError("callback must be a function");
    }
    // 1. Let video be the HTMLVideoElement on which requestVideoFrameCallback is invoked.
    // 2. Increment video's ownerDocument's video frame request callback identifier by one.
    videoFrameRequestCallbackIdentifier++;
    // 3. Let callbackId be video's ownerDocument's video frame request callback identifier
    const callbackId = videoFrameRequestCallbackIdentifier;
    // 4. Append callback to video's list of video frame request callbacks, associated with callbackId.
    this.#videoFrameRequestCallbacks.set(callbackId, callback);
    // A frame may already have been presented, which the callback should see
    // at the next rendering.
    this.#scheduleVideoFrameRequestCallbacks();
    // 5. Return callbackId.
    return callbackId;
  }

  // https://wicg.github.io/video-rvfc/#dom-htmlvideoelement-cancelvideoframecallback
  cancelVideoFrameCallback(handle: number): void {
    // 2. Find the entry in video's list of video frame request callbacks that is associated with the value handle.
    // 3. If there is such an entry, set its canceled boolean to true and remove it
    //    from video's list of video frame request callbacks.
    // (We only run the callbacks that are still in the list, see
    // #runVideoFrameRequestCallbacks, so removing it is enough.)
    this.#videoFrameRequestCallbacks.delete(handle);
  }

  // https://w3c.github.io/media-playback-quality/#dom-htmlvideoelement-getvideoplaybackquality
  getVideoPlaybackQuality(): BabyVideoPlaybackQuality {
    // 1. Let playbackQuality be a new instance of VideoPlaybackQuality.
    // 2. Set playbackQuality.creationTime to the current high resolution time.
    // 3. Set playbackQuality.totalVideoFrames to the current value of the total video frame count.
    // 4. Set playbackQuality.droppedVideoFrames to the current value of the dropped video frame count.
    // 5. [DEPRECATED] Set playbackQuality.corruptedVideoFrames to the current value of the corrupted video frame count.
    //    (Always 0.)
    // 6. Return playbackQuality.
    return new BabyVideoPlaybackQuality(
      performance.now(),
      this.#droppedVideoFrameCount,
      this.#totalVideoFrameCount
    );
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
    this.#queueMediaElementTask(
      () => {
        // 2.1. Fire an event named playing at the element.
        this.dispatchEvent(new Event("playing"));
        // 2.2. Resolve pending play promises with promises.
        promises.forEach((deferred) => deferred.resolve());
      },
      () => promises.forEach((deferred) => deferred.resolve())
    );
    this.#updatePlaying();
  }

  #internalPlay(): void {
    // https://html.spec.whatwg.org/multipage/media.html#internal-play-steps
    // 2. If the playback has ended and the direction of playback is forwards,
    //    seek to the earliest possible position of the media resource.
    if (this.#playbackRate >= 0 && this.#ended) {
      this.#seek(0);
    }
    // Deviation from the spec: likewise, if playback has ended (i.e. reached the
    // start) and the direction of playback is backwards, seek to the end.
    if (this.#playbackRate < 0 && this.#ended) {
      this.#seek(this.#duration);
    }
    if (this.#paused) {
      // 3. If the media element's paused attribute is true, then:
      // 3.1. Change the value of paused to false.
      this.#paused = false;
      this.#updatePlayed();
      // 3.2. If the show poster flag is true, set the element's show poster flag to false
      //      and run the time marches on steps.
      if (this.#showPoster) {
        this.#setShowPoster(false);
        this.#timeMarchesOn(false, performance.now());
      }
      // 3.3. Queue a media element task given the media element to fire an event named play at the element.
      this.#queueMediaElementTask(() => this.dispatchEvent(new Event("play")));
      if (this.#readyState <= MediaReadyState.HAVE_CURRENT_DATA) {
        // 3.4. If the media element's readyState attribute has the value HAVE_NOTHING, HAVE_METADATA, or HAVE_CURRENT_DATA,
        //      queue a media element task given the media element to fire an event named waiting at the element.
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("waiting"))
        );
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
      const resolve = () => promises.forEach((deferred) => deferred.resolve());
      this.#queueMediaElementTask(resolve, resolve);
    }
    // 5. Set the media element's can autoplay flag to false.
    this.#canAutoplay = false;
  }

  pause(): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-pause
    this.#internalPause();
  }

  #internalPause(): void {
    // https://html.spec.whatwg.org/multipage/media.html#internal-pause-steps
    // 1. Set the media element's can autoplay flag to false.
    this.#canAutoplay = false;
    // 2. If the media element's paused attribute is false, run the following steps:
    if (!this.#paused) {
      // 2.1. Change the value of paused to true.
      this.#updatePlayed();
      this.#paused = true;
      this.#updatePlayed();
      this.#updatePosterVisibility();
      // 2.2. Take pending play promises and let promises be the result.
      const promises = this.#takePendingPlayPromises();
      // 2.3. Queue a media element task given the media element and the following steps:
      const error = new DOMException(
        "Aborted by a call to pause()",
        "AbortError"
      );
      this.#queueMediaElementTask(
        () => {
          // 2.3.1. Fire an event named timeupdate at the element.
          this.dispatchEvent(new Event("timeupdate"));
          // 2.3.2. Fire an event named pause at the element.
          this.dispatchEvent(new Event("pause"));
          // 2.3.3. Reject pending play promises with promises and an "AbortError" DOMException.
          promises.forEach((deferred) => deferred.reject(error));
          // 2.4. Set the official playback position to the current playback position.
          // (The pipeline reports the current playback position when it stops
          // playing, see #updatePlaying() below.)
          this.#timeMarchesOn(false, performance.now());
        },
        () => promises.forEach((deferred) => deferred.reject(error))
      );
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

  // Tells the pipeline whether the playback position should advance:
  // when potentially playing, and not seeking.
  // https://html.spec.whatwg.org/multipage/media.html#potentially-playing
  #updatePlaying(): void {
    const playing = this.#isPotentiallyPlaying() && !this.#seeking;
    this.#pipeline?.setPlaying(playing);
    // The audio context lives on the main thread, so we resume and suspend it
    // here. (Resuming may need a user gesture, see the autoplay policy.)
    if (
      this.#audioOutput !== undefined &&
      playing !== this.#audioOutputPlaying
    ) {
      this.#audioOutputPlaying = playing;
      if (playing) {
        this.#audioOutput.resume();
      } else {
        this.#audioOutput.suspend();
      }
    }
  }

  #createAudioOutput({
    sampleRate,
    numberOfChannels,
    port
  }: MediaPipelineAudioOutputInit): void {
    this.#audioOutput?.close();
    // The audio context must run at the same sample rate as the decoded audio,
    // which is not necessarily the sample rate from the decoder config:
    // with HE-AAC, the decoder outputs twice the declared sample rate.
    const pipeline = this.#pipeline!;
    const audioOutput = new AudioOutput({
      sampleRate,
      numberOfChannels,
      port,
      gain: this.#getGain(),
      onClock: (snapshot) => {
        if (this.#audioOutput === audioOutput) {
          pipeline.updateAudioClock(snapshot);
        }
      }
    });
    this.#audioOutput = audioOutput;
    // Start or stop the new audio output.
    this.#audioOutputPlaying = !this.#audioOutputPlaying;
    this.#updatePlaying();
  }

  // The pipeline moved the current playback position.
  // https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource
  // https://html.spec.whatwg.org/multipage/media.html#time-marches-on
  #onTimeUpdate(currentTime: number, isNormalPlayback: boolean): void {
    this.#updateCurrentTime(currentTime);
    // Ending playback stops the playback position from advancing.
    this.#updatePlaying();
    this.#timeMarchesOn(isNormalPlayback, performance.now());
  }

  // https://html.spec.whatwg.org/multipage/media.html#official-playback-position
  #updateCurrentTime(currentTime: number) {
    this.#currentTime = currentTime;
    this.#updatePlayed();
    this.#updateEnded();
  }

  #updateEnded() {
    // https://html.spec.whatwg.org/multipage/media.html#reaches-the-end
    // When the current playback position reaches the end of the media resource when the direction of playback
    // is forwards, then the user agent must follow these steps:
    // 1. If the media element has a loop attribute specified, then seek to the earliest possible position
    //    of the media resource and return.
    // Deviation from the spec: likewise, when the current playback position reaches the earliest possible position
    // when the direction of playback is backwards, then seek to the end of the media resource.
    // (That's what play() does after reverse playback ends too, see #internalPlay().)
    if (this.loop && !this.#paused && !this.#seeking && this.#isAtEdge()) {
      this.#seek(this.#playbackRate >= 0 ? 0 : this.#duration);
      return;
    }
    const wasEnded = this.#ended;
    this.#ended = this.#hasEndedPlayback();
    if (wasEnded || !this.#ended) {
      return;
    }
    // When the current playback position reaches the end of the media resource
    // when the direction of playback is forwards, then the user agent must follow these steps:
    if (this.#playbackRate >= 0) {
      // 3. Queue a media element task given the media element and the following steps:
      this.#queueMediaElementTask(() => {
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
      this.#queueMediaElementTask(() => {
        this.dispatchEvent(new Event("timeupdate"));
        // Deviation from the spec: also pause, like when reaching the end
        // in the forward direction (but without firing ended). Otherwise the
        // element stays "playing" without anything to play, and play() can't
        // be used to restart playback (see #internalPlay()).
        if (this.#ended && this.#playbackRate < 0 && !this.#paused) {
          this.#paused = true;
          this.#updatePlaying();
          this.dispatchEvent(new Event("pause"));
          const error = new DOMException(
            "Aborted because reached start",
            "AbortError"
          );
          this.#takePendingPlayPromises().forEach((deferred) =>
            deferred.reject(error)
          );
        }
      });
    }
  }

  #hasEndedPlayback(): boolean {
    // https://html.spec.whatwg.org/multipage/media.html#ended-playback
    // A media element is said to have ended playback when:
    // * The element's readyState attribute is HAVE_METADATA or greater, and
    // * Either the current playback position is the end of the media resource, and the direction of playback
    //   is forwards, and the media element does not have a loop attribute specified,
    // * Or the current playback position is the earliest possible position, and the direction of playback
    //   is backwards.
    // Deviation from the spec: a loop attribute also loops backwards (see #updateEnded()).
    return !this.loop && this.#isAtEdge();
  }

  // Whether the current playback position is at the end of the media resource
  // in the direction of playback.
  #isAtEdge(): boolean {
    if (this.#readyState < MediaReadyState.HAVE_METADATA) {
      return false;
    }
    if (this.#playbackRate >= 0) {
      return this.#isEndOfStream && this.#currentTime === this.#duration;
    } else {
      return this.#currentTime === 0;
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
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("timeupdate"))
      );
    }
  }

  #seek(newPosition: number): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
    // 1. Set the media element's show poster flag to false.
    this.#setShowPoster(false);
    // 2. If the media element's readyState is HAVE_NOTHING, return.
    if (this.#readyState === MediaReadyState.HAVE_NOTHING) {
      return;
    }
    // 3. If the element's seeking IDL attribute is true, then another instance of this algorithm is already running.
    //    Abort that other instance of the algorithm without waiting for the step that it is running to complete.
    // (The pipeline aborts its previous seek when it starts a new one.)
    this.#updatePlayed();
    // 4. Set the seeking IDL attribute to true.
    this.#seeking = true;
    // Stop advancing the playback position.
    this.#updatePlaying();
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
    this.#queueMediaElementTask(() => this.dispatchEvent(new Event("seeking")));
    // 11. Set the current playback position to the new playback position.
    this.#updateCurrentTime(newPosition);
    // 12. Wait until the user agent has established whether or not the media data for the new playback position
    //     is available, and, if it is, until it has decoded enough data to play back that position.
    // (The pipeline calls #onSeekComplete() when it's done.)
    this.#pipeline?.seek(newPosition);
  }

  #onSeekComplete(): void {
    // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
    // 13. Await a stable state.
    // 14. Set the seeking IDL attribute to false.
    this.#seeking = false;
    this.#updatePlaying();
    this.#updatePlayed();
    // 15. Run the time marches on steps.
    this.#timeMarchesOn(false, performance.now());
    // 16. Queue a media element task given the media element to fire an event named timeupdate at the element.
    this.#queueMediaElementTask(() =>
      this.dispatchEvent(new Event("timeupdate"))
    );
    // 17. Queue a media element task given the media element to fire an event named seeked at the element.
    this.#queueMediaElementTask(() => this.dispatchEvent(new Event("seeked")));
  }

  #getGain(): number {
    return this.#muted ? 0 : this.#volume;
  }

  #updateVolume(): void {
    this.#audioOutput?.setGain(this.#getGain());
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
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("durationchange"))
      );
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
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("loadedmetadata"))
      );
      // https://html.spec.whatwg.org/multipage/media.html#media-data-processing-steps-list
      // Once enough of the media data has been fetched to determine the duration of the media resource,
      // its dimensions, and other metadata:
      // 7. If the media element's default playback start position is greater than zero,
      //    then seek to that time, and let jumped be true.
      // 8. Set the media element's default playback start position to zero.
      const defaultPlaybackStartPosition = this.#defaultPlaybackStartPosition;
      this.#defaultPlaybackStartPosition = 0;
      if (defaultPlaybackStartPosition > 0) {
        this.#seek(defaultPlaybackStartPosition);
      }
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
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("loadeddata"))
        );
        // We now have video data to show instead of the poster frame.
        this.#updatePosterVisibility();
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
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("timeupdate"))
        );
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("waiting"))
        );
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
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("canplay"))
      );
      // If the element's paused attribute is false, the user agent must notify about playing for the element.
      if (!this.#paused) {
        this.#notifyAboutPlaying();
      }
    }
    // If the new ready state is HAVE_ENOUGH_DATA
    if (newReadyState === MediaReadyState.HAVE_ENOUGH_DATA) {
      // Note: the first step is handled together with HAVE_FUTURE_DATA
      // The user agent must queue a media element task given the media element to fire an event named canplaythrough at the element.
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("canplaythrough"))
      );
      // If the element is not eligible for autoplay, then the user agent must abort these substeps.
      if (this.#isEligibleForAutoplay()) {
        // The user agent may run the following substeps:
        // 1. Set the paused attribute to false.
        this.#paused = false;
        this.#updatePlayed();
        // 2. If the element's show poster flag is true, set it to false and run the time marches on steps.
        if (this.#showPoster) {
          this.#setShowPoster(false);
          this.#timeMarchesOn(false, performance.now());
        }
        // 3. Queue a media element task given the element to fire an event named play at the element.
        this.#queueMediaElementTask(() =>
          this.dispatchEvent(new Event("play"))
        );
        // 4. Notify about playing for the element.
        this.#notifyAboutPlaying();
      }
    }
  }

  // https://html.spec.whatwg.org/multipage/media.html#eligible-for-autoplay
  #isEligibleForAutoplay(): boolean {
    // its can autoplay flag is true;
    // its paused attribute is true;
    // it has an autoplay attribute specified;
    // (We don't do lazy loading or sandboxing.)
    return this.#canAutoplay && this.#paused && this.autoplay;
  }

  #updateSize(width: number, height: number): void {
    this.#videoWidth = width;
    this.#videoHeight = height;
    // https://html.spec.whatwg.org/multipage/media.html#concept-video-intrinsic-width
    // Whenever the intrinsic width or intrinsic height of the video changes
    // (including, for example, because the selected video track was changed),
    // if the element's readyState attribute is not HAVE_NOTHING,
    // the user agent must queue a media element task given the media element
    // to fire an event named resize at the media element.
    if (this.#readyState !== MediaReadyState.HAVE_NOTHING) {
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("resize"))
      );
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
      this.#queueMediaElementTask(() =>
        this.dispatchEvent(new Event("progress"))
      );
    } else {
      this.#nextProgressTimer = setTimeout(
        () => this.#notifyProgress(),
        timeUntilNextProgress
      );
    }
  }

  #notifyEndOfStream(): void {
    this.#isEndOfStream = true;
    // We may already be at the (new) end of the media resource.
    this.#updateEnded();
  }

  #notifyStreamReopened(): void {
    this.#isEndOfStream = false;
    // The old end is no longer the end of the media resource.
    this.#updateEnded();
  }

  #onVideoFramePresented(frame: PresentedVideoFrame): void {
    // https://w3c.github.io/media-playback-quality/#concepts
    // The total video frame count is incremented when a video frame is displayed,
    // and when the dropped video frame count is incremented.
    this.#onVideoFramesDropped(frame.droppedFrames);
    this.#totalVideoFrameCount++;
    this.#presentedFrames++;
    // https://wicg.github.io/video-rvfc/#video-frame-callback-metadata-attributes
    // The pipeline may live in a worker, with a different time origin.
    this.#latestPresentedFrame = {
      presentationTime: frame.presentationTime - performance.timeOrigin,
      expectedDisplayTime: frame.expectedDisplayTime - performance.timeOrigin,
      width: frame.width,
      height: frame.height,
      mediaTime: frame.mediaTime,
      presentedFrames: this.#presentedFrames,
      processingDuration: frame.processingDuration
    };
    this.#scheduleVideoFrameRequestCallbacks();
  }

  #onVideoFramesDropped(droppedFrames: number): void {
    // https://w3c.github.io/media-playback-quality/#concepts
    // The total video frame count is incremented when the dropped video frame count is incremented.
    this.#totalVideoFrameCount += droppedFrames - this.#droppedVideoFrameCount;
    this.#droppedVideoFrameCount = droppedFrames;
  }

  // https://wicg.github.io/video-rvfc/#video-rvfc-procedures
  // The callbacks run in the update the rendering steps, right before the
  // animation frame callbacks. We can't hook into those steps, so we run them
  // in an animation frame callback of our own instead.
  #scheduleVideoFrameRequestCallbacks(): void {
    if (
      this.#videoFrameCallbacksAnimationFrame === 0 &&
      this.#videoFrameRequestCallbacks.size > 0 &&
      this.#latestPresentedFrame !== undefined &&
      this.#latestPresentedFrame.presentedFrames !==
        this.#lastPresentedFrameIdentifier
    ) {
      this.#videoFrameCallbacksAnimationFrame = requestAnimationFrame((now) => {
        this.#videoFrameCallbacksAnimationFrame = 0;
        this.#runVideoFrameRequestCallbacks(now);
      });
    }
  }

  // https://wicg.github.io/video-rvfc/#run-the-video-frame-request-callbacks
  #runVideoFrameRequestCallbacks(now: number): void {
    // 1. If video's list of video frame request callbacks is empty, abort these steps.
    if (this.#videoFrameRequestCallbacks.size === 0) {
      return;
    }
    // 2. Let metadata be the VideoFrameCallbackMetadata dictionary built from video's latest presented frame.
    const metadata = this.#latestPresentedFrame;
    if (metadata === undefined) {
      return;
    }
    // 3. Let presentedFrames be the value of metadata's presentedFrames field.
    const presentedFrames = metadata.presentedFrames;
    // 4. If the last presented frame identifier is equal to presentedFrames, abort these steps.
    if (this.#lastPresentedFrameIdentifier === presentedFrames) {
      return;
    }
    // 5. Set the last presented frame identifier to presentedFrames.
    this.#lastPresentedFrameIdentifier = presentedFrames;
    // 6. Let callbacks be the list of video frame request callbacks.
    const callbacks = this.#videoFrameRequestCallbacks;
    // 7. Set video's list of video frame request callbacks to be empty.
    this.#videoFrameRequestCallbacks = new Map();
    // 8. For each entry of callbacks:
    for (const callback of callbacks.values()) {
      // 8.1. If entry's canceled boolean is true, continue.
      //      (Canceled entries were removed from the list before we got here.)
      // 8.2. Invoke entry with « now, metadata » and "report".
      //      (Each invocation converts the dictionary to a new JavaScript object.)
      try {
        callback.call(undefined, now, { ...metadata });
      } catch (e) {
        reportError(e);
      }
    }
  }

  static {
    getPipelineHost = (element) => element.#pipelineHost;
    updateReadyState = (element, readyState) =>
      element.#updateReadyState(readyState);
    updateDuration = (element, duration) => element.#updateDuration(duration);
    notifyProgress = (element) => element.#notifyProgress();
    notifyEndOfStream = (element) => element.#notifyEndOfStream();
    notifyStreamReopened = (element) => element.#notifyStreamReopened();
    onTimeUpdate = (element, currentTime, isNormalPlayback) =>
      element.#onTimeUpdate(currentTime, isNormalPlayback);
    onSeekComplete = (element) => element.#onSeekComplete();
    updateSize = (element, width, height) => element.#updateSize(width, height);
    onVideoFramePresented = (element, frame) =>
      element.#onVideoFramePresented(frame);
    onVideoFramesDropped = (element, droppedFrames) =>
      element.#onVideoFramesDropped(droppedFrames);
    onPipelineError = (element, error, message) =>
      element.#onPipelineError(error, message);
    createAudioOutput = (element, init) => element.#createAudioOutput(init);
  }
}

// The view of a BabyVideoElement that a media pipeline reports to.
// Each pipeline gets its own host, so that a detached pipeline
// can no longer affect the element.
class BabyVideoElementPipelineHost implements MediaPipelineHost {
  readonly #element: BabyVideoElement;

  constructor(element: BabyVideoElement) {
    this.#element = element;
  }

  #isCurrent(): boolean {
    return getPipelineHost(this.#element) === this;
  }

  onReadyStateChange(readyState: MediaReadyState): void {
    if (this.#isCurrent()) updateReadyState(this.#element, readyState);
  }

  onDurationChange(duration: number): void {
    if (this.#isCurrent()) updateDuration(this.#element, duration);
  }

  onProgress(): void {
    if (this.#isCurrent()) notifyProgress(this.#element);
  }

  onBufferedChange(): void {
    // The element reads the mirrored ranges from the MediaPipelineProxy.
  }

  onEndOfStream(): void {
    if (this.#isCurrent()) notifyEndOfStream(this.#element);
  }

  onStreamReopened(): void {
    if (this.#isCurrent()) notifyStreamReopened(this.#element);
  }

  onTimeUpdate(currentTime: number, isNormalPlayback: boolean): void {
    if (this.#isCurrent()) {
      onTimeUpdate(this.#element, currentTime, isNormalPlayback);
    }
  }

  onSeekComplete(): void {
    if (this.#isCurrent()) onSeekComplete(this.#element);
  }

  onResize(width: number, height: number): void {
    if (this.#isCurrent()) updateSize(this.#element, width, height);
  }

  onVideoFramePresented(frame: PresentedVideoFrame): void {
    if (this.#isCurrent()) onVideoFramePresented(this.#element, frame);
  }

  onVideoFramesDropped(droppedFrames: number): void {
    if (this.#isCurrent()) onVideoFramesDropped(this.#element, droppedFrames);
  }

  onError(error: MediaPipelineError, message: string): void {
    if (this.#isCurrent()) onPipelineError(this.#element, error, message);
  }

  createAudioOutput(init: MediaPipelineAudioOutputInit): void {
    if (this.#isCurrent()) {
      createAudioOutput(this.#element, init);
    } else {
      init.port.close();
    }
  }
}

// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-non-negative-integers
// Returns undefined if the value is absent or can't be parsed.
function parseDimension(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const match = /^[\t\n\f\r ]*\+?(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

// Like the constants of a WebIDL interface, these are also on the prototype.
for (const name of [
  "NETWORK_EMPTY",
  "NETWORK_IDLE",
  "NETWORK_LOADING",
  "NETWORK_NO_SOURCE",
  "HAVE_NOTHING",
  "HAVE_METADATA",
  "HAVE_CURRENT_DATA",
  "HAVE_FUTURE_DATA",
  "HAVE_ENOUGH_DATA"
] as const) {
  Object.defineProperty(BabyVideoElement.prototype, name, {
    value: BabyVideoElement[name],
    enumerable: true
  });
}

customElements.define("baby-video", BabyVideoElement);
