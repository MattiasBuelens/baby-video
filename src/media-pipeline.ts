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
  MediaReadyState,
  type MediaSourceAttachment
} from "./media-source-attachment";
import { arrayRemoveAt, Deferred, Direction, sumWith } from "./util";
import { TimeRanges } from "./time-ranges";
import {
  AudioDecodeQueue,
  AudioTrackBuffer,
  EncodedChunk,
  VideoDecodeQueue,
  VideoTrackBuffer
} from "./track-buffer";
import { BabyAudioSink } from "./audio-sink";
import type { AudioClockSnapshot } from "./audio-output";
import type {
  AudioSinkDirection,
  AudioSinkStatusMessage
} from "./audio-sink-messages";

// The media element side of a MediaPipeline.
// The pipeline reports everything that the media element needs to know
// through these callbacks.
export interface MediaPipelineHost {
  // HTMLMediaElement.readyState changed.
  onReadyStateChange(readyState: MediaReadyState): void;
  // The duration of the media resource changed.
  onDurationChange(duration: number): void;
  // New media data was appended.
  onProgress(): void;
  // The buffered ranges changed (other than by appending media data).
  onBufferedChange(): void;
  // The media element now has all of the media data.
  onEndOfStream(): void;
  // The current playback position changed, either through the usual monotonic
  // increase during normal playback, or because playback stopped.
  onTimeUpdate(currentTime: number, isNormalPlayback: boolean): void;
  // The pipeline has decoded enough data to play back the seek target.
  onSeekComplete(): void;
  // The intrinsic size of the video changed.
  onResize(width: number, height: number): void;
  // A video frame was drawn to the canvas.
  onVideoFramePresented(frame: PresentedVideoFrame): void;
  // Video frames were dropped, without presenting a new frame.
  // `droppedFrames` is the total number of dropped frames so far.
  onVideoFramesDropped(droppedFrames: number): void;
  // The pipeline needs an audio output for decoded audio with this format.
  // The host creates an AudioContext (which only exists on the main thread)
  // with an audio worklet, and hands `port` to that worklet. The pipeline
  // talks to the worklet through the other end of that port, and the host
  // reports the audio clock with MediaPipeline.updateAudioClock().
  createAudioOutput(init: MediaPipelineAudioOutputInit): void;
}

// A video frame that the pipeline drew to the canvas, for the media element's
// video frame request callbacks and its playback quality.
// https://wicg.github.io/video-rvfc/#video-frame-callback-metadata
// https://w3c.github.io/media-playback-quality/#concepts
export interface PresentedVideoFrame {
  // These two are high resolution times relative to the Unix epoch rather than
  // to performance.timeOrigin, since the pipeline may live in a worker,
  // which has a different time origin than the element's window.
  readonly presentationTime: number;
  readonly expectedDisplayTime: number;
  // The size of the frame in media pixels, i.e. without the pixel aspect ratio.
  readonly width: number;
  readonly height: number;
  // The presentation timestamp of the frame, in seconds.
  readonly mediaTime: number;
  // The time from submitting the frame to the decoder until it was ready
  // for presentation, in seconds.
  readonly processingDuration: number;
  // The total number of dropped frames so far.
  readonly droppedFrames: number;
}

export interface MediaPipelineAudioOutputInit {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly port: MessagePort;
}

// The canvas that the pipeline renders video frames to.
// On the main thread, this is the media element's own canvas. In a worker,
// the element transfers control of its canvas to an OffscreenCanvas.
export type MediaPipelineCanvas = HTMLCanvasElement | OffscreenCanvas;
type MediaPipelineCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export interface MediaPipelineInit {
  readonly playbackRate: number;
}

// Low and high watermark for decode queue
// If the queue drops below the LWM, we try to fill it with up to HWM new frames
const decodeQueueLwm = 20;
const decodeQueueHwm = 30;

// Low and high watermark for the audio sink, in seconds of buffered audio.
// Unlike video, audio is buffered by duration rather than by frame count:
// an HE-AAC frame holds 2048 samples where a plain AAC frame holds 1024,
// so a frame count would mean wildly different amounts of audio.
const audioBufferLwm = 1;
const audioBufferHwm = 2;

// Maximum number of audio frames to decode in one batch for reverse playback.
// A batch is only pushed to the audio sink once it's fully decoded (see
// #processAudioDecodeQueue), so a large batch can starve the sink right after
// a seek. A small batch means more preroll frames to decode, which is cheap.
const maxReverseAudioBatchFrames = 16;

const DEBUG = false;

// Bug showcases
const BUG_DECODE_VIDEO_IN_REVERSE = false;

// What we know about a decoded video frame, but the VideoFrame doesn't.
interface DecodedVideoFrameInfo {
  readonly width: number;
  readonly height: number;
  readonly processingDuration: number;
}

// A decoded audio frame, with the timestamp and duration of the encoded chunk
// it was decoded from. The decoder does not preserve those itself, see
// #processAudioDecodeQueue().
interface DecodedAudioFrame {
  readonly frame: AudioData;
  readonly timestamp: number;
  readonly duration: number;
}

// A batch of audio frames that is decoded in forward order, but must be rendered
// in reverse order. Its frames are held back until the whole batch is decoded.
interface ReverseAudioBatch {
  remaining: number;
  readonly decoded: DecodedAudioFrame[];
}

// A chunk of audio that was pushed to the audio sink.
interface PushedAudioChunk {
  readonly timestamp: number;
  readonly duration: number;
  readonly sequence: number;
}

// The media pipeline of a <baby-video> element: everything between the
// MediaSource's track buffers and the screen and speakers.
//
// It decodes audio and video, renders video frames to a canvas, pushes decoded
// audio to the audio sink, owns the playback clock, and waits for seeks to
// complete. The media element itself only implements the HTML media element
// state machine (attributes, events and play promises) on top of it.
//
// The pipeline lives in the same realm as the MediaSource it's attached to,
// since it reads from its track buffers synchronously.
export class MediaPipeline implements MediaSourceAttachment {
  readonly #mediaSource: BabyMediaSource;
  readonly #host: MediaPipelineHost;
  readonly #canvas: MediaPipelineCanvas;
  readonly #canvasContext: MediaPipelineCanvasContext;

  #currentTime: number = 0;
  #playbackRate: number;
  #readyState: MediaReadyState = MediaReadyState.HAVE_NOTHING;
  // Whether the media element is potentially playing and not seeking,
  // i.e. whether the playback position should advance.
  #playing: boolean = false;
  #seeking: boolean = false;
  #detached: boolean = false;

  #advanceLoop: number = 0;
  // Whether we're inside #advanceCurrentTime().
  #advancing: boolean = false;
  #lastAdvanceTime: number = 0;
  #seekAbortController: AbortController = new AbortController();
  #nextReadyStateChangePromise: Deferred<void> | undefined = undefined;

  readonly #videoDecoder: VideoDecoder;
  #lastVideoDecoderConfig: VideoDecoderConfig | undefined = undefined;
  #furthestDecodingVideoFrame: EncodedVideoChunk | undefined = undefined;
  #decodingVideoFrames: EncodedVideoChunk[] = [];
  #decodedVideoFrames: VideoFrame[] = [];
  #nextDecodedVideoFramePromise: Deferred<void> | undefined = undefined;
  #lastRenderedFrame: number | undefined = undefined;
  #nextRenderFrame: number = 0;
  #needKeyFrame: boolean = true;
  // Frames that are only decoded because a later frame depends on them,
  // e.g. the frames between a key frame and the seek target.
  // They are never meant to be presented, so they don't count as dropped.
  #prerollVideoFrames: WeakSet<EncodedVideoChunk> = new WeakSet();
  // When each frame was submitted to the decoder, for its processingDuration.
  #videoFrameDecodeStartTimes: WeakMap<EncodedVideoChunk, number> =
    new WeakMap();
  #decodedVideoFrameInfo: WeakMap<VideoFrame, DecodedVideoFrameInfo> =
    new WeakMap();
  // https://w3c.github.io/media-playback-quality/#concepts
  // The dropped video frame count, kept here because only the pipeline knows
  // when a frame misses its display deadline. The element keeps the rest.
  #droppedVideoFrames: number = 0;
  #reportedDroppedVideoFrames: number = 0;
  // The timestamp of the last animation frame that rendered video,
  // and the time between the last two, to estimate when the next one is.
  #lastRenderTime: number = 0;
  #renderInterval: number = 1000 / 60;

  readonly #audioDecoder: AudioDecoder;
  #lastAudioDecoderConfig: AudioDecoderConfig | undefined = undefined;
  #audioDecoderTimestamp: number = 0;
  #furthestDecodedAudioFrame: EncodedAudioChunk | undefined = undefined;
  #decodingAudioFrames: EncodedAudioChunk[] = [];
  #nextDecodedAudioFramePromise: Deferred<void> | undefined = undefined;
  #originalDecodingAudioFrames: WeakMap<EncodedAudioChunk, EncodedAudioChunk> =
    new WeakMap();
  // Frames that are only decoded to prime the decoder, see AudioDecodeQueue.
  #prerollAudioFrames: WeakSet<EncodedAudioChunk> = new WeakSet();
  // For reverse playback: the batch that each decoding frame belongs to.
  #reverseAudioBatchOfFrame: WeakMap<EncodedAudioChunk, ReverseAudioBatch> =
    new WeakMap();
  #reverseAudioBatches: ReverseAudioBatch[] = [];

  #audioSink: BabyAudioSink | undefined;
  // Audio that was handed to the sink but not consumed by it yet, in push order.
  // Doubles as the record of which audio is available for seek completion.
  #pushedAudioChunks: PushedAudioChunk[] = [];

  constructor(
    mediaSource: BabyMediaSource,
    host: MediaPipelineHost,
    canvas: MediaPipelineCanvas,
    init: MediaPipelineInit
  ) {
    this.#mediaSource = mediaSource;
    this.#host = host;
    this.#canvas = canvas;
    // TypeScript can't resolve the getContext() overload on a union type.
    this.#canvasContext = canvas.getContext("2d") as MediaPipelineCanvasContext;
    this.#canvasContext.fillStyle = "black";
    this.#canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    this.#playbackRate = init.playbackRate;

    this.#videoDecoder = new VideoDecoder({
      output: (frame) => this.#onVideoFrame(frame),
      error: (error) => console.error("WTF", error)
    });

    this.#audioDecoder = new AudioDecoder({
      output: (data) => this.#onAudioData(data),
      error: (error) => console.error("WTF", error)
    });

    attachToMediaElement(mediaSource, this);
  }

  // region MediaSourceAttachment

  get readyState(): MediaReadyState {
    return this.#readyState;
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  get playbackRate(): number {
    return this.#playbackRate;
  }

  updateDuration(newDuration: number): void {
    // https://w3c.github.io/media-source/#duration-change-algorithm
    // 6.1. Update the media element's duration to new duration.
    // 6.2. Run the HTMLMediaElement duration change algorithm.
    // (https://html.spec.whatwg.org/multipage/media.html#dom-media-duration, run by the element.)
    this.#host.onDurationChange(newDuration);
  }

  updateReadyState(newReadyState: MediaReadyState): void {
    // https://html.spec.whatwg.org/multipage/media.html#ready-states
    // The element fires the events for this transition (see #updateReadyState
    // in BabyVideoElement). The pipeline only has to start decoding or
    // rendering, and wake up a pending seek.
    const previousReadyState = this.#readyState;
    this.#readyState = newReadyState;
    this.#host.onReadyStateChange(newReadyState);
    if (this.#detached || previousReadyState === newReadyState) {
      return;
    }
    if (this.#nextReadyStateChangePromise) {
      this.#nextReadyStateChangePromise.resolve();
      this.#nextReadyStateChangePromise = undefined;
    }
    if (
      previousReadyState === MediaReadyState.HAVE_METADATA &&
      newReadyState >= MediaReadyState.HAVE_CURRENT_DATA &&
      this.#advanceLoop === 0
    ) {
      // Show the first frame, even if we're not playing.
      this.#scheduleRenderVideoFrame();
    }
    if (
      previousReadyState <= MediaReadyState.HAVE_CURRENT_DATA &&
      newReadyState >= MediaReadyState.HAVE_FUTURE_DATA
    ) {
      // Decode more frames
      this.#decodeVideoFrames();
      this.#decodeAudio();
    }
  }

  notifyProgress(): void {
    // https://html.spec.whatwg.org/multipage/media.html#concept-media-load-resource (the progress event, fired by the element)
    this.#host.onProgress();
  }

  // e.g. after https://w3c.github.io/media-source/#dfn-coded-frame-removal
  notifyBufferedChange(): void {
    this.#host.onBufferedChange();
  }

  notifyEndOfStream(): void {
    // https://w3c.github.io/media-source/#dfn-end-of-stream
    // 3.2. Notify the media element that it now has all of the media data.
    this.#host.onEndOfStream();
  }

  // endregion

  // region Commands from the media element

  get buffered(): TimeRanges {
    // https://w3c.github.io/media-source/#htmlmediaelement-extensions-buffered
    return getBuffered(this.#mediaSource);
  }

  // Starts or stops advancing the playback position, i.e. whether the
  // media element is potentially playing and not seeking.
  // https://html.spec.whatwg.org/multipage/media.html#potentially-playing
  setPlaying(playing: boolean): void {
    if (this.#detached || playing === this.#playing) {
      return;
    }
    if (playing) {
      this.#playing = true;
      if (this.#advanceLoop === 0) {
        this.#lastAdvanceTime = performance.now();
        this.#advanceLoop = requestAnimationFrame((now) =>
          this.#advanceCurrentTime(now)
        );
      }
    } else {
      // Settle on the current playback position, so the element can set its
      // official playback position to it.
      // https://html.spec.whatwg.org/multipage/media.html#official-playback-position
      // https://html.spec.whatwg.org/multipage/media.html#internal-pause-steps (step 2.4)
      // (If we stop while advancing, then the advance loop is already
      // reporting the current position.)
      const currentTime = this.#advancing
        ? this.#currentTime
        : this.#getCurrentPlaybackPosition(performance.now());
      this.#playing = false;
      cancelAnimationFrame(this.#advanceLoop);
      this.#advanceLoop = 0;
      if (currentTime !== this.#currentTime) {
        this.#setCurrentTime(currentTime);
        this.#host.onTimeUpdate(currentTime, false);
      }
    }
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-playbackrate
  setPlaybackRate(playbackRate: number): void {
    if (this.#detached || playbackRate === this.#playbackRate) {
      return;
    }
    const currentTime = this.#getCurrentPlaybackPosition(performance.now());
    if (Math.sign(playbackRate) !== Math.sign(this.#playbackRate)) {
      this.#resetVideoDecoder();
      this.#resetAudioDecoder(currentTime);
    }
    this.#playbackRate = playbackRate;
    this.#setCurrentTime(currentTime);
    this.#audioSink?.setPlaybackRate(playbackRate);
    this.#host.onTimeUpdate(currentTime, false);
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
  // 11. Set the current playback position to the new playback position.
  // 12. Wait until the user agent has established whether or not the media data for the new playback position
  //     is available, and, if it is, until it has decoded enough data to play back that position.
  // Calls MediaPipelineHost.onSeekComplete() when done, so the element can
  // run the remaining steps.
  seek(newPosition: number): void {
    if (this.#detached) {
      return;
    }
    // Abort any previous seek.
    this.#seekAbortController.abort();
    this.#seeking = true;
    this.#resetVideoDecoder();
    this.#resetAudioDecoder(newPosition);
    this.#setCurrentTime(newPosition);
    this.#seekAbortController = new AbortController();
    this.#waitForSeekToComplete(
      Math.floor(1e6 * newPosition),
      this.#seekAbortController.signal
    ).catch(() => {});
  }

  // The audio output sent a new snapshot of its clock.
  updateAudioClock(snapshot: AudioClockSnapshot): void {
    const sink = this.#audioSink;
    if (this.#detached || sink === undefined) {
      return;
    }
    const wasRunning = sink.clockState === "running";
    sink.updateClock(snapshot);
    if (!wasRunning && snapshot.state === "running") {
      this.#onAudioContextRunning();
    }
  }

  // Detaches from the MediaSource and releases all resources.
  detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#playing = false;
    this.#seeking = false;
    this.#seekAbortController.abort();
    cancelAnimationFrame(this.#advanceLoop);
    this.#advanceLoop = 0;
    cancelAnimationFrame(this.#nextRenderFrame);
    this.#nextRenderFrame = 0;
    this.#resetVideoDecoder();
    this.#resetAudioDecoder(0);
    this.#audioSink?.close();
    this.#audioSink = undefined;
    this.#videoDecoder.close();
    this.#audioDecoder.close();
    detachFromMediaElement(this.#mediaSource);
  }

  // endregion

  #getCurrentPlaybackPosition(now: number): number {
    // https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource
    // When a media element is potentially playing and its Document is a fully active Document,
    // its current playback position must increase monotonically at the element's playbackRate units
    // of media time per unit time of the media timeline's clock.
    if (this.#playing && !this.#seeking) {
      // Use audio clock as sync, otherwise use wall-clock time.
      // The audio sink reports an anchor { mediaTime, contextTime, effectiveRate }
      // from the audio worklet, which we extrapolate with AudioContext.currentTime.
      // That extrapolation is exact for as long as the effective rate stays
      // constant, and the effective rate is 0 whenever the worklet is starved or
      // stopped, so the clock stalls rather than running away.
      // Only follow the audio clock where there is audio to play. Tracks can
      // end at different times: past the end of the audio (e.g. right after
      // seeking to the very end in reverse), the sink is starved and its clock
      // stands still, so use the wall clock until we reach the audio.
      let newTime = this.#hasBufferedFrameAtTime(
        getActiveAudioTrackBuffer(this.#mediaSource),
        Math.floor(1e6 * this.#currentTime)
      )
        ? this.#audioSink?.getPosition()
        : undefined;
      if (newTime === undefined) {
        // There's no audio track, no audio at current time,
        // or no audio clock to sync with (yet).
        const elapsedTime = Math.max(0, (now - this.#lastAdvanceTime) / 1000);
        newTime = this.#currentTime + this.#playbackRate * elapsedTime;
      } else if (this.#playbackRate >= 0) {
        // Unlike the wall clock, the audio clock is absolute rather than
        // incremental, so it must be kept from moving against the direction of
        // playback, e.g. while AudioContext.resume() is still pending.
        newTime = Math.max(this.#currentTime, newTime);
      } else {
        newTime = Math.min(this.#currentTime, newTime);
      }
      // Do not advance outside the current buffered range.
      const currentRange = this.buffered.find(this.#currentTime);
      if (currentRange !== undefined) {
        return Math.min(Math.max(currentRange[0], newTime), currentRange[1]);
      }
    }
    return this.#currentTime;
  }

  #setCurrentTime(currentTime: number): void {
    // Whenever the current playback position changes, the MediaSource checks
    // whether it still has enough data: https://w3c.github.io/media-source/#buffer-monitoring
    this.#currentTime = currentTime;
    this.#decodeVideoFrames();
    this.#decodeAudio();
    checkBuffer(this.#mediaSource);
  }

  // Advances the current playback position during normal playback.
  // https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource
  // The element then runs the "time marches on" steps (see #timeMarchesOn).
  #advanceCurrentTime(now: number): void {
    this.#advancing = true;
    try {
      const currentTime = this.#getCurrentPlaybackPosition(now);
      this.#lastAdvanceTime = now;
      this.#setCurrentTime(currentTime);
      this.#renderVideoFrame(now);
      this.#host.onTimeUpdate(this.#currentTime, true);
    } finally {
      this.#advancing = false;
    }
    if (this.#playing && !this.#seeking) {
      this.#advanceLoop = requestAnimationFrame((now) =>
        this.#advanceCurrentTime(now)
      );
    } else {
      this.#advanceLoop = 0;
    }
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
        await this.#waitForNextReadyStateChange(signal);
      } else if (
        !this.#hasDecodedVideoFrameAtTime(timeInMicros) &&
        this.#hasBufferedFrameAtTime(
          getActiveVideoTrackBuffer(this.#mediaSource),
          timeInMicros
        )
      ) {
        await this.#waitForNextDecodedVideoFrame(signal);
      } else if (
        !this.#hasDecodedAudioFrameAtTime(timeInMicros) &&
        this.#hasBufferedFrameAtTime(
          getActiveAudioTrackBuffer(this.#mediaSource),
          timeInMicros
        )
      ) {
        await this.#waitForNextDecodedAudioFrame(signal);
      } else {
        break;
      }
    }
    this.#seeking = false;
    this.#host.onSeekComplete();
  }

  async #waitForNextReadyStateChange(signal: AbortSignal): Promise<void> {
    this.#nextReadyStateChangePromise = new Deferred<void>();
    this.#nextReadyStateChangePromise.follow(signal);
    await this.#nextReadyStateChangePromise.promise;
  }

  #hasDecodedVideoFrameAtTime(timeInMicros: number): boolean {
    return this.#hasDecodedFrameAtTime(this.#decodedVideoFrames, timeInMicros);
  }

  #hasDecodedAudioFrameAtTime(timeInMicros: number): boolean {
    // Decoded audio is handed to the sink immediately, so we have to look at
    // what we pushed to it rather than at a queue of decoded frames.
    return this.#hasDecodedFrameAtTime(this.#pushedAudioChunks, timeInMicros);
  }

  // The time to look up the frame at current time with, see isFrameAtTime().
  // findFrameForTime() uses forward semantics, so for reverse playback we look
  // just before current time, to find the frame *ending* at a frame boundary.
  #frameLookupTime(
    direction: Direction,
    time: number = this.#currentTime
  ): number {
    // Look 10µs back, to step over rounding gaps between frames (see isFrameAtTime).
    return direction === Direction.BACKWARD ? Math.max(0, time - 1e-5) : time;
  }

  // Whether the track has a frame at the given time at all.
  // Tracks can end at different times (e.g. audio may extend past the last
  // video frame), so there might be nothing to decode for that track.
  #hasBufferedFrameAtTime(
    trackBuffer: AudioTrackBuffer | VideoTrackBuffer | undefined,
    timeInMicros: number
  ): boolean {
    if (trackBuffer === undefined) {
      return false;
    }
    const direction = this.#frameDirectionAt(timeInMicros);
    return (
      trackBuffer.findFrameForTime(
        this.#frameLookupTime(direction, timeInMicros / 1e6)
      ) !== undefined
    );
  }

  #hasDecodedFrameAtTime(
    frames: ReadonlyArray<{ timestamp: number; duration: number | null }>,
    timeInMicros: number
  ): boolean {
    const direction = this.#frameDirectionAt(timeInMicros);
    return frames.some((frame) =>
      isFrameAtTime(frame, direction, timeInMicros)
    );
  }

  // The direction to use for isFrameAtTime() and isFrameBeyondTime().
  // Backward, the frame at a time is the one *ending* there, but no frame ends
  // at the very start. There, the first frame is the one at current time, as if
  // playing forward. (Reverse playback ends there, so there's nothing to play.)
  #frameDirectionAt(timeInMicros: number): Direction {
    return this.#playbackRate < 0 && timeInMicros > 0
      ? Direction.BACKWARD
      : Direction.FORWARD;
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
    const mediaSource = this.#mediaSource;
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
      const frameAtTime = videoTrackBuffer.findFrameForTime(
        this.#frameLookupTime(direction)
      );
      if (frameAtTime === undefined) {
        return;
      }
      this.#processVideoDecodeQueue(
        videoTrackBuffer.getDecodeDependenciesForFrame(frameAtTime),
        direction,
        frameAtTime
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

  // Decodes the frames in the queue. Going forward, the frames that end
  // before `firstFrameToPresent` are only decoded because that frame
  // depends on them.
  #processVideoDecodeQueue(
    decodeQueue: VideoDecodeQueue,
    direction: Direction,
    firstFrameToPresent?: EncodedVideoChunk
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
      this.#needKeyFrame = true;
    }
    if (direction === Direction.BACKWARD && BUG_DECODE_VIDEO_IN_REVERSE) {
      frames.reverse();
    }
    const prerollEnd =
      direction === Direction.FORWARD && firstFrameToPresent !== undefined
        ? firstFrameToPresent.timestamp
        : -Infinity;
    for (const frame of frames) {
      // The frames are in decode order, so check their presentation time.
      const isPreroll = frame.timestamp + (frame.duration ?? 0) <= prerollEnd;
      if (this.#needKeyFrame) {
        if (frame.type === "key") {
          this.#needKeyFrame = false;
        } else {
          // Drop non-keyframe
          continue;
        }
      }
      if (isPreroll) {
        this.#prerollVideoFrames.add(frame);
      } else {
        this.#prerollVideoFrames.delete(frame);
      }
      this.#videoFrameDecodeStartTimes.set(frame, performance.now());
      this.#videoDecoder.decode(frame);
      this.#decodingVideoFrames.push(frame);
    }
    if (direction === Direction.BACKWARD && !BUG_DECODE_VIDEO_IN_REVERSE) {
      // The decoder may hold on to the last few frames for reordering, until it
      // sees more input. Backward, the next batch is an earlier GOP, which we
      // might not decode until these frames come out, so flush them out now.
      // After a flush, the decoder needs a key frame, which an earlier GOP
      // starts with anyway.
      this.#videoDecoder.flush().catch(() => {});
      this.#needKeyFrame = true;
    }
    // The "furthest decoded frame" depends on the rendering order,
    // since we must decode the frames in their original order.
    if (direction === Direction.BACKWARD && !BUG_DECODE_VIDEO_IN_REVERSE) {
      this.#furthestDecodingVideoFrame = frames[0];
    } else {
      this.#furthestDecodingVideoFrame = frames[frames.length - 1];
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
    const direction = this.#frameDirectionAt(currentTimeInMicros);
    if (isFrameBeyondTime(decodingFrame, direction, currentTimeInMicros)) {
      if (DEBUG) {
        console.log(
          `dropping decoded video frame at timestamp=${decodingFrame.timestamp}, beyond currentTime=${currentTimeInMicros}us`
        );
      }
      // https://w3c.github.io/media-playback-quality/#concepts
      // The dropped video frame count is incremented when a video frame is
      // decoded but dropped because it missed a display deadline.
      // (A preroll frame never had a display deadline.)
      if (!this.#prerollVideoFrames.has(decodingFrame)) {
        this.#droppedVideoFrames++;
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
    // https://wicg.github.io/video-rvfc/#dom-videoframecallbackmetadata-processingduration
    // The elapsed duration from submission of the encoded packet to the decoder
    // until the decoded frame was ready for presentation. That includes our
    // copy to an ImageBitmap.
    const decodeStartTime =
      this.#videoFrameDecodeStartTimes.get(decodingFrame) ?? performance.now();
    this.#decodedVideoFrameInfo.set(newFrame, {
      // In media pixels, i.e. before applying the pixel aspect ratio.
      width: frame.visibleRect?.width ?? frame.codedWidth,
      height: frame.visibleRect?.height ?? frame.codedHeight,
      processingDuration: (performance.now() - decodeStartTime) / 1000
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
      this.#nextRenderFrame = requestAnimationFrame((now) =>
        this.#renderVideoFrame(now)
      );
    }
  }

  // Renders the video frame at the current playback position.
  // Always runs in an animation frame callback, with its timestamp as `now`.
  #renderVideoFrame(now: number): void {
    this.#nextRenderFrame = 0;
    const lastRenderInterval = now - this.#lastRenderTime;
    if (lastRenderInterval > 0 && lastRenderInterval < 100) {
      // Probably one display frame (or a few, if we missed some).
      this.#renderInterval = lastRenderInterval;
    }
    this.#lastRenderTime = now;
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction = this.#frameDirectionAt(currentTimeInMicros);
    // Drop all frames that are before current time, since we're too late to render them.
    for (let i = this.#decodedVideoFrames.length - 1; i >= 0; i--) {
      const frame = this.#decodedVideoFrames[i];
      if (isFrameBeyondTime(frame, direction, currentTimeInMicros)) {
        // https://w3c.github.io/media-playback-quality/#concepts
        // The dropped video frame count is incremented when a video frame is
        // decoded but dropped because it missed a display deadline.
        this.#droppedVideoFrames++;
        frame.close();
        arrayRemoveAt(this.#decodedVideoFrames, i);
      }
    }
    // Render the frame at current time.
    let currentFrameIndex = this.#decodedVideoFrames.findIndex((frame) =>
      isFrameAtTime(frame, direction, currentTimeInMicros)
    );
    if (currentFrameIndex < 0) {
      this.#reportDroppedVideoFrames();
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
      this.#presentVideoFrame(frame, now);
      frame.close();
    } else {
      this.#reportDroppedVideoFrames();
    }
    // Decode more frames (if we now have more space in the queue)
    this.#decodeVideoFrames();
  }

  // Tells the media element that we drew a new video frame to the canvas.
  #presentVideoFrame(frame: VideoFrame, now: number): void {
    const info = this.#decodedVideoFrameInfo.get(frame);
    this.#reportedDroppedVideoFrames = this.#droppedVideoFrames;
    // https://wicg.github.io/video-rvfc/#video-frame-callback-metadata-attributes
    this.#host.onVideoFramePresented({
      // We submit the frame for composition by drawing it to the canvas.
      // The canvas is then shown at the end of this animation frame,
      // so we expect it on the screen at the next one.
      presentationTime: performance.timeOrigin + performance.now(),
      expectedDisplayTime: performance.timeOrigin + now + this.#renderInterval,
      width: info?.width ?? frame.displayWidth,
      height: info?.height ?? frame.displayHeight,
      mediaTime: frame.timestamp / 1e6,
      // Round to 100µs, as the spec suggests against fingerprinting.
      // https://wicg.github.io/video-rvfc/#security-and-privacy
      processingDuration:
        Math.round((info?.processingDuration ?? 0) * 1e4) / 1e4,
      droppedFrames: this.#droppedVideoFrames
    });
  }

  #reportDroppedVideoFrames(): void {
    if (this.#reportedDroppedVideoFrames !== this.#droppedVideoFrames) {
      this.#reportedDroppedVideoFrames = this.#droppedVideoFrames;
      this.#host.onVideoFramesDropped(this.#droppedVideoFrames);
    }
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
    this.#needKeyFrame = true;
    this.#videoDecoder.reset();
  }

  #decodeAudio(): void {
    const mediaSource = this.#mediaSource;
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
      const frameAtTime = audioTrackBuffer.findFrameForTime(
        this.#frameLookupTime(direction)
      );
      if (frameAtTime === undefined) {
        return;
      }
      this.#processAudioDecodeQueue(
        audioTrackBuffer.getDecodeDependenciesForFrame(frameAtTime),
        direction
      );
    }
    // Decode next frames in advance
    let bufferedAhead = this.#audioBufferedAhead();
    while (bufferedAhead < audioBufferLwm) {
      const lastFrame = this.#furthestDecodedAudioFrame!;
      const frameDuration = (lastFrame.duration ?? 0) / 1e6;
      const frameCount =
        frameDuration > 0
          ? Math.ceil((audioBufferHwm - bufferedAhead) / frameDuration)
          : decodeQueueHwm;
      const nextQueue = audioTrackBuffer.getNextFrames(
        lastFrame,
        direction === Direction.BACKWARD
          ? Math.min(Math.max(1, frameCount), maxReverseAudioBatchFrames)
          : Math.max(1, frameCount),
        direction
      );
      if (nextQueue === undefined) {
        break;
      }
      this.#processAudioDecodeQueue(nextQueue, direction);
      bufferedAhead = this.#audioBufferedAhead();
    }
  }

  // The amount of audio we've already decoded or are decoding, in seconds.
  #audioBufferedAhead(): number {
    const pushed = sumWith(this.#pushedAudioChunks, (chunk) => chunk.duration);
    const decoding = sumWith(this.#decodingAudioFrames, (chunk) =>
      this.#prerollAudioFrames.has(chunk) ? 0 : chunk.duration!
    );
    const held = sumWith(this.#reverseAudioBatches, (batch) =>
      sumWith(batch.decoded, (frame) => frame.duration)
    );
    return (pushed + decoding + held) / 1e6;
  }

  #processAudioDecodeQueue(
    decodeQueue: AudioDecodeQueue,
    direction: Direction
  ): void {
    const { frames, preroll, codecConfig } = decodeQueue;
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
    // Always decode in forward order, even for reverse playback: audio frames
    // depend on the previous frame (see AudioDecodeQueue.preroll). For reverse
    // playback, we hold back the decoded frames until the whole batch is done,
    // and then push them to the sink in reverse order.
    const batch: ReverseAudioBatch | undefined =
      direction === Direction.BACKWARD
        ? { remaining: frames.length, decoded: [] }
        : undefined;
    if (batch !== undefined) {
      this.#reverseAudioBatches.push(batch);
    }
    for (const frame of [...preroll, ...frames]) {
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
      if (!frames.includes(frame)) {
        this.#prerollAudioFrames.add(newFrame);
      } else if (batch !== undefined) {
        this.#reverseAudioBatchOfFrame.set(newFrame, batch);
      }
      this.#audioDecoder.decode(newFrame);
      this.#decodingAudioFrames.push(newFrame);
      this.#audioDecoderTimestamp += frame.duration!;
    }
    // The "furthest audio frame" is the last one in rendering order.
    this.#furthestDecodedAudioFrame =
      direction === Direction.BACKWARD ? frames[0] : frames[frames.length - 1];
  }

  #onAudioData(frame: AudioData): void {
    let decodingFrameIndex = this.#decodingAudioFrames.findIndex((x) =>
      isFrameTimestampEqual(x, frame)
    );
    if (
      decodingFrameIndex < 0 &&
      this.#decodingAudioFrames.length > 0 &&
      frame.timestamp > this.#decodingAudioFrames[0].timestamp
    ) {
      // The decoder computes output timestamps from the number of decoded
      // samples, which drifts from our chunk timestamps whenever a chunk's
      // duration doesn't match its decoded length. For example, the last frame
      // of a stream is often shorter than a full AAC frame, yet still decodes
      // to a full frame. The decoder outputs frames in decode order, so this
      // must be the oldest frame that's still decoding.
      decodingFrameIndex = 0;
    }
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
    if (this.#prerollAudioFrames.has(decodingFrame)) {
      // Only decoded to prime the decoder.
      frame.close();
      return;
    }
    // Restore the original timestamp, which the decoder did not preserve.
    const originalFrame = this.#originalDecodingAudioFrames.get(decodingFrame)!;
    const decodedFrame: DecodedAudioFrame = {
      frame,
      timestamp: originalFrame.timestamp,
      duration: originalFrame.duration!
    };
    const batch = this.#reverseAudioBatchOfFrame.get(decodingFrame);
    if (batch === undefined) {
      this.#renderDecodedAudioFrame(decodedFrame);
    } else {
      batch.decoded.push(decodedFrame);
      batch.remaining--;
      if (batch.remaining > 0) {
        return;
      }
      // The decoder outputs frames in order, so batches complete in order too.
      arrayRemoveAt(
        this.#reverseAudioBatches,
        this.#reverseAudioBatches.indexOf(batch)
      );
      for (let i = batch.decoded.length - 1; i >= 0; i--) {
        this.#renderDecodedAudioFrame(batch.decoded[i]);
      }
    }
    if (this.#nextDecodedAudioFramePromise) {
      this.#nextDecodedAudioFramePromise.resolve();
      this.#nextDecodedAudioFramePromise = undefined;
    }
    // Decode more frames (if we now have more space in the queue)
    this.#decodeAudio();
  }

  #renderDecodedAudioFrame(decodedFrame: DecodedAudioFrame): void {
    const { frame } = decodedFrame;
    // Drop frames that are beyond current time, since we're too late to render them.
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    const direction =
      this.#playbackRate < 0 ? Direction.BACKWARD : Direction.FORWARD;
    if (
      isFrameBeyondTime(
        decodedFrame,
        this.#frameDirectionAt(currentTimeInMicros),
        currentTimeInMicros
      )
    ) {
      if (DEBUG) {
        console.log(
          `dropping decoded audio frame at timestamp=${decodedFrame.timestamp}, beyond currentTime=${currentTimeInMicros}us`
        );
      }
      frame.close();
      return;
    }
    if (DEBUG) {
      console.log(`decoded audio frame at timestamp=${decodedFrame.timestamp}`);
    }
    this.#pushAudioToSink(decodedFrame, direction);
  }

  #ensureAudioSink(
    sampleRate: number,
    numberOfChannels: number
  ): BabyAudioSink {
    if (this.#audioSink === undefined) {
      // The audio context must run at the same sample rate as the decoded audio,
      // which is not necessarily the sample rate from the decoder config:
      // with HE-AAC, the decoder outputs twice the declared sample rate.
      // We talk to the audio worklet through our own port. Until the host has
      // loaded the worklet and handed it the other end of the port, all our
      // messages are queued on that port.
      const { port1, port2 } = new MessageChannel();
      this.#audioSink = new BabyAudioSink({
        port: port1,
        numberOfChannels,
        onStatus: (status) => this.#onAudioSinkStatus(status)
      });
      this.#audioSink.setPlaybackRate(this.#playbackRate);
      this.#host.createAudioOutput({
        sampleRate,
        numberOfChannels,
        port: port2
      });
    }
    return this.#audioSink;
  }

  #pushAudioToSink(
    decodedFrame: DecodedAudioFrame,
    direction: Direction
  ): void {
    const { frame, timestamp, duration } = decodedFrame;
    const sink = this.#ensureAudioSink(
      frame.sampleRate,
      frame.numberOfChannels
    );
    if (DEBUG && frame.numberOfChannels !== sink.numberOfChannels) {
      console.warn(
        `audio frame has ${frame.numberOfChannels} channels, but the audio sink has ${sink.numberOfChannels}`
      );
    }
    const sequence = sink.push({
      // The samples are reversed for reverse playback, so the first sample
      // is the *end* of the frame.
      headMediaTime:
        direction === Direction.BACKWARD ? timestamp + duration : timestamp,
      direction: direction as AudioSinkDirection,
      sampleRate: frame.sampleRate,
      numberOfChannels: frame.numberOfChannels,
      numberOfFrames: frame.numberOfFrames,
      samples: copyAudioDataToSamples(frame, direction)
    });
    frame.close();
    this.#pushedAudioChunks.push({ timestamp, duration, sequence });
  }

  #onAudioSinkStatus(status: AudioSinkStatusMessage): void {
    // Forget about the audio that the sink has already played.
    while (
      this.#pushedAudioChunks.length > 0 &&
      this.#pushedAudioChunks[0].sequence <= status.lastConsumedSequence
    ) {
      this.#pushedAudioChunks.shift();
    }
    if (DEBUG && status.starved) {
      console.warn(`audio sink is starved at ${status.mediaTime}us`);
    }
    // Decode more audio (if the sink now has more space)
    this.#decodeAudio();
  }

  #onAudioContextRunning(): void {
    // If the queued audio no longer covers current time, then we've been
    // running on the wall clock while the audio context was blocked by the
    // autoplay policy. Start over from current time, so the first audible
    // sample is in sync with the video.
    const currentTimeInMicros = Math.floor(1e6 * this.#currentTime);
    if (
      this.#pushedAudioChunks.length > 0 &&
      !this.#hasDecodedAudioFrameAtTime(currentTimeInMicros)
    ) {
      this.#resetAudioDecoder(this.#currentTime);
      this.#decodeAudio();
    }
  }

  #resetAudioDecoder(mediaTime: number): void {
    this.#lastAudioDecoderConfig = undefined;
    this.#audioDecoderTimestamp = 0;
    this.#furthestDecodedAudioFrame = undefined;
    this.#decodingAudioFrames.length = 0;
    this.#audioDecoder.reset();
    for (const batch of this.#reverseAudioBatches) {
      for (const decodedFrame of batch.decoded) {
        decodedFrame.frame.close();
      }
    }
    this.#reverseAudioBatches.length = 0;
    this.#pushedAudioChunks.length = 0;
    // Drop all queued audio, and report the new position until it catches up.
    this.#audioSink?.flush(Math.round(1e6 * mediaTime));
  }

  #updateSize(width: number, height: number): void {
    // https://html.spec.whatwg.org/multipage/media.html#concept-video-intrinsic-width
    // (The element fires the resize event.)
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
      this.#host.onResize(width, height);
    }
  }
}

// Whether the frame is the one to render at the given time.
// Forward, that's the frame covering [timestamp, timestamp + duration).
// Backward, it's the frame covering (timestamp, timestamp + duration]: at a
// frame boundary, the frame *before* the boundary plays next. This must agree
// with isFrameBeyondTime(), or a frame can be "at" the current time and
// "beyond" it at the same time, and a seek to that time never completes.
function isFrameAtTime(
  frame: { timestamp: number; duration: number | null },
  direction: Direction,
  timeInMicros: number
): boolean {
  const end = frame.timestamp + frame.duration!;
  if (direction == Direction.FORWARD) {
    return frame.timestamp <= timeInMicros && timeInMicros < end;
  } else {
    // Timestamps are rounded to whole microseconds, so a frame can end slightly
    // before the next one starts. Allow for that, or a frame boundary might fall
    // in between two frames.
    return (
      frame.timestamp < timeInMicros &&
      timeInMicros <= end + getFrameTolerance(frame)
    );
  }
}

function isFrameBeyondTime(
  frame: { timestamp: number; duration: number | null },
  direction: Direction,
  timeInMicros: number
): boolean {
  if (direction == Direction.FORWARD) {
    return frame.timestamp + frame.duration! <= timeInMicros;
  } else {
    return frame.timestamp >= timeInMicros;
  }
}

function getFrameTolerance(frame: { duration: number | null }) {
  return Math.ceil(frame.duration! / 16);
}

function isFrameTimestampEqual(
  left: EncodedChunk,
  right: AudioData | VideoFrame
): boolean {
  // Due to rounding, there can be a small gap between encoded and decoded frames.
  return Math.abs(left.timestamp - right.timestamp) <= getFrameTolerance(left);
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

// Copies the samples of an audio frame into a single planar Float32Array,
// with all channels concatenated.
function copyAudioDataToSamples(
  frame: AudioData,
  direction: Direction
): Float32Array {
  const format = "f32-planar";
  const { numberOfChannels, numberOfFrames } = frame;
  const samples = new Float32Array(numberOfChannels * numberOfFrames);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const plane = samples.subarray(
      channel * numberOfFrames,
      (channel + 1) * numberOfFrames
    );
    frame.copyTo(plane, { format, planeIndex: channel });
    if (direction === Direction.BACKWARD) {
      // For reverse playback, reverse the order of the individual samples.
      plane.reverse();
    }
  }
  return samples;
}
