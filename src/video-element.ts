import stylesheet from "./style.css?inline";
import { BabyMediaSource } from "./media-source";
import { Deferred, queueTask } from "./util";
import { TimeRange, TimeRanges } from "./time-ranges";
import { MediaReadyState } from "./media-source-attachment";
import {
  MediaPipeline,
  type MediaPipelineAudioOutputInit,
  type MediaPipelineHost
} from "./media-pipeline";
import { AudioOutput } from "./audio-output";

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

let createAudioOutput: (
  element: BabyVideoElement,
  init: MediaPipelineAudioOutputInit
) => void;

// A partial re-implementation of the HTML <video> element.
//
// This class implements the HTML media element state machine: its attributes,
// events and play promises. Everything that actually plays media (decoding,
// rendering and the playback clock) lives in the MediaPipeline, which reports
// back through MediaPipelineHost.
export class BabyVideoElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement;

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
  #videoWidth: number;
  #videoHeight: number;

  #pendingPlayPromises: Array<Deferred<void>> = [];
  #lastPlayedTime: number = NaN;
  #lastTimeUpdate: number = 0;
  #lastProgress: number = 0;
  #nextProgressTimer: number = 0;
  #hasFiredLoadedData: boolean = false;
  #isEndOfStream: boolean = false;

  #pipeline: MediaPipeline | undefined;
  #pipelineHost: MediaPipelineHost | undefined;
  #audioOutput: AudioOutput | undefined;
  #audioOutputPlaying: boolean = false;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(template.content.cloneNode(true));

    // The default object size is a width of 300 CSS pixels and a height of 150 CSS pixels.
    this.#videoWidth = 300;
    this.#videoHeight = 150;
    this.#canvas = document.createElement("canvas");
    this.#canvas.width = 300;
    this.#canvas.height = 150;
    shadow.appendChild(this.#canvas);

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

  connectedCallback(): void {
    // Consider checking for properties that may have been set
    // before the element upgraded.
    // https://web.dev/custom-elements-best-practices/
    this.#upgradeProperty("srcObject");
    this.#upgradeProperty("muted");
    this.#upgradeProperty("playbackRate");
    this.#upgradeProperty("volume");
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
    return this.#pipeline ? this.#pipeline.buffered : new TimeRanges([]);
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
    this.#playbackRate = value;
    // The pipeline settles on the current playback position at the old rate,
    // and reports it back through #onTimeUpdate().
    this.#pipeline?.setPlaybackRate(value);
    this.#updatePlaying();
    this.#updatePlayed();
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
    this.#pipeline?.detach();
    this.#pipeline = undefined;
    this.#pipelineHost = undefined;
    this.#audioOutput?.close();
    this.#audioOutput = undefined;
    this.#audioOutputPlaying = false;
    this.#srcObject = srcObject;
    this.#currentTime = 0;
    this.#duration = NaN;
    this.#hasFiredLoadedData = false;
    this.#ended = false;
    this.#paused = true;
    this.#played = new TimeRanges([]);
    this.#readyState = MediaReadyState.HAVE_NOTHING;
    this.#seeking = false;
    this.#isEndOfStream = false;
    this.#lastProgress = 0;
    this.#lastPlayedTime = NaN;
    clearTimeout(this.#nextProgressTimer);
    this.#lastTimeUpdate = 0;
    queueTask(() => this.dispatchEvent(new Event("emptied")));
    if (srcObject) {
      this.#pipelineHost = new BabyVideoElementPipelineHost(this);
      this.#pipeline = new MediaPipeline(
        srcObject,
        this.#pipelineHost,
        this.#canvas,
        {
          playbackRate: this.#playbackRate
        }
      );
    }
  }

  get videoWidth(): number {
    return this.#videoWidth;
  }

  get videoHeight(): number {
    return this.#videoHeight;
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
        // (The pipeline reports the current playback position when it stops
        // playing, see #updatePlaying() below.)
        this.#timeMarchesOn(false, performance.now());
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
      queueTask(() => {
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
    queueTask(() => this.dispatchEvent(new Event("seeking")));
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
    queueTask(() => this.dispatchEvent(new Event("timeupdate")));
    // 17. Queue a media element task given the media element to fire an event named seeked at the element.
    queueTask(() => this.dispatchEvent(new Event("seeked")));
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
    }
    // If the new ready state is HAVE_ENOUGH_DATA
    if (newReadyState === MediaReadyState.HAVE_ENOUGH_DATA) {
      // Note: the first step is handled together with HAVE_FUTURE_DATA
      // The user agent must queue a media element task given the media element to fire an event named canplaythrough at the element.
      queueTask(() => this.dispatchEvent(new Event("canplaythrough")));
    }
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

  #notifyEndOfStream(): void {
    this.#isEndOfStream = true;
  }

  static {
    getPipelineHost = (element) => element.#pipelineHost;
    updateReadyState = (element, readyState) =>
      element.#updateReadyState(readyState);
    updateDuration = (element, duration) => element.#updateDuration(duration);
    notifyProgress = (element) => element.#notifyProgress();
    notifyEndOfStream = (element) => element.#notifyEndOfStream();
    onTimeUpdate = (element, currentTime, isNormalPlayback) =>
      element.#onTimeUpdate(currentTime, isNormalPlayback);
    onSeekComplete = (element) => element.#onSeekComplete();
    updateSize = (element, width, height) => element.#updateSize(width, height);
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

  onEndOfStream(): void {
    if (this.#isCurrent()) notifyEndOfStream(this.#element);
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

  createAudioOutput(init: MediaPipelineAudioOutputInit): void {
    if (this.#isCurrent()) {
      createAudioOutput(this.#element, init);
    } else {
      init.port.close();
    }
  }
}

customElements.define("baby-video", BabyVideoElement);
