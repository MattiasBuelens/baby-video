import type { BabyMediaSource } from "./media-source";
import { getBuffered } from "./media-source";
import {
  MediaPipeline,
  type MediaPipelineAudioOutputInit,
  type MediaPipelineCanvas,
  type MediaPipelineError,
  type MediaPipelineHost,
  type MediaPipelineInit,
  type PresentedVideoFrame
} from "./media-pipeline";
import type { MediaReadyState } from "./media-source-attachment";
import type { TimeRange } from "./time-ranges";
import type {
  PipelineCommandMessage,
  PipelineEventMessage
} from "./pipeline-messages";

// The pipeline's end of the port between a <baby-video> element and its media
// pipeline. Lives in the same realm as the MediaSource: on the main thread,
// or in the worker that created it.
//
// It receives commands from the element (see MediaPipelineProxy) and runs
// them on the pipeline, and it forwards the pipeline's reports to the element.
export class MediaPipelineEndpoint implements MediaPipelineHost {
  readonly #mediaSource: BabyMediaSource;
  readonly #port: MessagePort;
  #pipeline: MediaPipeline | undefined;
  #closed: boolean = false;
  // The epoch of the last seek command.
  #seekEpoch: number = 0;
  #lastBuffered: TimeRange[] = [];

  constructor(mediaSource: BabyMediaSource, port: MessagePort) {
    this.#mediaSource = mediaSource;
    this.#port = port;
    this.#port.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data as PipelineCommandMessage);
    };
  }

  // Attaches the MediaSource to the element, and creates the pipeline.
  // https://w3c.github.io/media-source/#mediasource-attach
  // On the main thread, the element calls this directly with its own canvas.
  // From a worker, it sends an "attach" message with an OffscreenCanvas.
  attach(canvas: MediaPipelineCanvas, init: MediaPipelineInit): void {
    if (this.#closed || this.#pipeline !== undefined) {
      return;
    }
    this.#pipeline = new MediaPipeline(this.#mediaSource, this, canvas, init);
  }

  #onMessage(message: PipelineCommandMessage): void {
    if (this.#closed) {
      return;
    }
    if (message.type === "attach") {
      this.attach(message.canvas, message.init);
      return;
    }
    const pipeline = this.#pipeline;
    if (pipeline === undefined) {
      return;
    }
    switch (message.type) {
      case "set-playing":
        pipeline.setPlaying(message.playing);
        break;
      case "set-playback-rate":
        pipeline.setPlaybackRate(message.playbackRate);
        break;
      case "set-bug-decode-video-in-reverse":
        pipeline.setBugDecodeVideoInReverse(message.value);
        break;
      case "seek":
        this.#seekEpoch = message.epoch;
        pipeline.seek(message.time);
        break;
      case "audio-clock":
        pipeline.updateAudioClock(message.snapshot);
        break;
      case "detach":
        this.detach();
        break;
    }
  }

  // https://w3c.github.io/media-source/#mediasource-detach
  // On the main thread, the element calls this directly, so the MediaSource
  // is closed by the time the element attaches it again. From a worker, it
  // sends a "detach" message.
  detach(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#pipeline?.detach();
    this.#pipeline = undefined;
    this.#port.close();
  }

  #post(message: PipelineEventMessage, transfer?: Transferable[]): void {
    if (this.#closed) {
      return;
    }
    // Every report may follow a change in the buffered ranges, and the element
    // must see that change before it handles the report.
    this.#syncBuffered();
    this.#port.postMessage(message, transfer ?? []);
  }

  // https://w3c.github.io/media-source/#htmlmediaelement-extensions-buffered
  #syncBuffered(): void {
    const ranges = getBuffered(this.#mediaSource).toArray();
    if (!areRangesEqual(ranges, this.#lastBuffered)) {
      this.#lastBuffered = ranges;
      this.#port.postMessage({
        type: "buffered",
        ranges
      } satisfies PipelineEventMessage);
    }
  }

  // region MediaPipelineHost

  onReadyStateChange(readyState: MediaReadyState): void {
    this.#post({ type: "ready-state", readyState });
  }

  onDurationChange(duration: number): void {
    this.#post({ type: "duration", duration });
  }

  onProgress(): void {
    this.#post({ type: "progress" });
  }

  onBufferedChange(): void {
    if (!this.#closed) {
      this.#syncBuffered();
    }
  }

  onEndOfStream(): void {
    this.#post({ type: "end-of-stream" });
  }

  onStreamReopened(): void {
    this.#post({ type: "stream-reopened" });
  }

  onTimeUpdate(currentTime: number, isNormalPlayback: boolean): void {
    this.#post({
      type: "time-update",
      epoch: this.#seekEpoch,
      currentTime,
      isNormalPlayback
    });
  }

  onSeekComplete(): void {
    this.#post({ type: "seek-complete", epoch: this.#seekEpoch });
  }

  onResize(width: number, height: number): void {
    this.#post({ type: "resize", width, height });
  }

  onVideoFramePresented(frame: PresentedVideoFrame): void {
    this.#post({ type: "video-frame-presented", frame });
  }

  onVideoFramesDropped(droppedFrames: number): void {
    this.#post({ type: "video-frames-dropped", droppedFrames });
  }

  onError(error: MediaPipelineError, message: string): void {
    this.#post({ type: "error", error, message });
  }

  createAudioOutput(init: MediaPipelineAudioOutputInit): void {
    this.#post(
      {
        type: "create-audio-output",
        sampleRate: init.sampleRate,
        numberOfChannels: init.numberOfChannels,
        port: init.port
      },
      [init.port]
    );
  }

  // endregion
}

function areRangesEqual(
  left: readonly TimeRange[],
  right: readonly TimeRange[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      ([start, end], i) => start === right[i][0] && end === right[i][1]
    )
  );
}
