import type { AudioClockSnapshot } from "./audio-output";
import type { MediaPipelineHost } from "./media-pipeline";
import { TimeRanges } from "./time-ranges";
import type {
  PipelineCommandMessage,
  PipelineEventMessage
} from "./pipeline-messages";

// The element's end of the port between a <baby-video> element and its media
// pipeline. Always lives on the main thread, with the element.
//
// It sends the element's commands to the pipeline (see MediaPipelineEndpoint),
// and reports the pipeline's events to the element's MediaPipelineHost.
// It also mirrors the pipeline's buffered ranges, so the element can read
// them synchronously.
export class MediaPipelineProxy {
  readonly #port: MessagePort;
  readonly #host: MediaPipelineHost;
  #buffered: TimeRanges = new TimeRanges([]);
  #playing: boolean = false;
  #seekEpoch: number = 0;
  #closed: boolean = false;

  constructor(port: MessagePort, host: MediaPipelineHost) {
    this.#port = port;
    this.#host = host;
    this.#port.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data as PipelineEventMessage);
    };
  }

  // https://w3c.github.io/media-source/#htmlmediaelement-extensions-buffered
  // The MediaSource computes the buffered ranges, and the pipeline sends them
  // whenever they change. Like the spec's cross-context attachment (for a
  // MediaSource in a worker), the element may see them a little late.
  get buffered(): TimeRanges {
    return this.#buffered;
  }

  #post(message: PipelineCommandMessage, transfer?: Transferable[]): void {
    if (this.#closed) {
      return;
    }
    this.#port.postMessage(message, transfer ?? []);
  }

  attach(canvas: OffscreenCanvas, playbackRate: number): void {
    this.#post({ type: "attach", canvas, playbackRate }, [canvas]);
  }

  setPlaying(playing: boolean): void {
    // The element updates this a lot, but it rarely changes.
    if (playing === this.#playing) {
      return;
    }
    this.#playing = playing;
    this.#post({ type: "set-playing", playing });
  }

  setPlaybackRate(playbackRate: number): void {
    this.#post({ type: "set-playback-rate", playbackRate });
  }

  // https://html.spec.whatwg.org/multipage/media.html#dom-media-seek
  seek(time: number): void {
    // Any playback position reported before the pipeline sees this seek
    // is stale.
    this.#seekEpoch++;
    this.#post({ type: "seek", epoch: this.#seekEpoch, time });
  }

  updateAudioClock(snapshot: AudioClockSnapshot): void {
    this.#post({ type: "audio-clock", snapshot });
  }

  // https://w3c.github.io/media-source/#mediasource-detach
  detach(): void {
    this.#post({ type: "detach" });
    this.#closed = true;
    this.#port.close();
  }

  #onMessage(message: PipelineEventMessage): void {
    if (this.#closed) {
      if (message.type === "create-audio-output") {
        message.port.close();
      }
      return;
    }
    const host = this.#host;
    switch (message.type) {
      case "ready-state":
        host.onReadyStateChange(message.readyState);
        break;
      case "duration":
        host.onDurationChange(message.duration);
        break;
      case "progress":
        host.onProgress();
        break;
      case "buffered":
        this.#buffered = new TimeRanges(message.ranges);
        host.onBufferedChange();
        break;
      case "end-of-stream":
        host.onEndOfStream();
        break;
      case "time-update":
        if (message.epoch === this.#seekEpoch) {
          host.onTimeUpdate(message.currentTime, message.isNormalPlayback);
        }
        break;
      case "seek-complete":
        if (message.epoch === this.#seekEpoch) {
          host.onSeekComplete();
        }
        break;
      case "resize":
        host.onResize(message.width, message.height);
        break;
      case "video-frame-presented":
        host.onVideoFramePresented(message.frame);
        break;
      case "video-frames-dropped":
        host.onVideoFramesDropped(message.droppedFrames);
        break;
      case "error":
        host.onError(message.error, message.message);
        break;
      case "create-audio-output":
        host.createAudioOutput({
          sampleRate: message.sampleRate,
          numberOfChannels: message.numberOfChannels,
          port: message.port
        });
        break;
    }
  }
}
