import type {
  AudioSinkDirection,
  AudioSinkInboundMessage,
  AudioSinkStatusMessage
} from "./audio-sink-messages";
import type { AudioClockSnapshot } from "./audio-output";
import { getAbsoluteTime } from "./util";

export interface BabyAudioSinkInit {
  // The port to the audio worklet, see AudioOutput.
  readonly port: MessagePort;
  readonly numberOfChannels: number;
  readonly onStatus: (status: AudioSinkStatusMessage) => void;
}

export interface AudioSinkChunk {
  readonly headMediaTime: number;
  readonly direction: AudioSinkDirection;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly samples: Float32Array;
}

interface AudioSinkAnchor {
  // Media time at `contextTime`, in seconds.
  readonly mediaTime: number;
  // AudioContext time this anchor is valid at, in seconds.
  readonly contextTime: number;
  // Media seconds per context second from `contextTime` onwards, signed.
  readonly effectiveRate: number;
}

// The media pipeline's side of the audio output.
//
// Pushes decoded audio to the audio worklet through a MessagePort. The worklet
// owns the sample queue, so we merely have to push decoded audio ahead of time.
// It also owns the playback position: it reports an anchor
// { mediaTime, contextTime, effectiveRate }, which we extrapolate with
// our estimate of AudioContext.currentTime. That extrapolation is exact for as
// long as the effective rate stays constant.
//
// The AudioContext itself lives on the main thread (see AudioOutput), so we
// can't read its currentTime directly. Instead, we extrapolate the latest
// AudioClockSnapshot that it sent us with the wall clock.
export class BabyAudioSink {
  readonly #port: MessagePort;
  readonly #onStatus: (status: AudioSinkStatusMessage) => void;
  readonly #numberOfChannels: number;

  #closed: boolean = false;
  #epoch: number = 0;
  #sequence: number = 0;
  #playbackRate: number = 1;
  #anchor: AudioSinkAnchor | undefined;
  #clock: AudioClockSnapshot | undefined;

  constructor(init: BabyAudioSinkInit) {
    this.#port = init.port;
    this.#onStatus = init.onStatus;
    this.#numberOfChannels = init.numberOfChannels;
    this.#port.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data as AudioSinkStatusMessage);
    };
    // Bring the worklet up to date, in case nothing else does.
    this.#post({
      type: "flush",
      epoch: this.#epoch,
      mediaTime: 0
    });
  }

  get clockState(): AudioClockSnapshot["state"] | undefined {
    return this.#clock?.state;
  }

  get failed(): boolean {
    return this.#clock?.state === "failed";
  }

  get numberOfChannels(): number {
    return this.#numberOfChannels;
  }

  // The AudioContext changed state, or sent a new clock snapshot.
  updateClock(snapshot: AudioClockSnapshot): void {
    this.#clock = snapshot;
    if (snapshot.state === "failed") {
      this.#anchor = undefined;
    }
  }

  // Our best estimate of AudioContext.currentTime right now.
  #getContextTime(): number {
    const clock = this.#clock;
    if (clock === undefined) {
      return 0;
    }
    if (clock.state !== "running") {
      return clock.contextTime;
    }
    return clock.contextTime + (getAbsoluteTime() - clock.timestamp) / 1000;
  }

  #onMessage(status: AudioSinkStatusMessage): void {
    // Statuses produced before the worklet saw our latest flush are stale:
    // accepting one would rewind the clock to before the seek.
    if (this.#closed || status.epoch !== this.#epoch || this.failed) {
      return;
    }
    this.#anchor = {
      mediaTime: status.mediaTime / 1e6,
      contextTime: status.contextTime,
      effectiveRate: status.effectiveRate
    };
    this.#onStatus(status);
  }

  #post(message: AudioSinkInboundMessage, transfer?: Transferable[]): void {
    if (this.#closed) {
      return;
    }
    this.#port.postMessage(message, transfer ?? []);
  }

  // Queues a chunk of audio for playback, and returns its sequence number.
  // The chunk's sample buffer is transferred, so it must not be used afterwards.
  push(chunk: AudioSinkChunk): number {
    const sequence = this.#sequence++;
    this.#post(
      {
        type: "push",
        epoch: this.#epoch,
        sequence,
        headMediaTime: chunk.headMediaTime,
        direction: chunk.direction,
        sampleRate: chunk.sampleRate,
        numberOfChannels: chunk.numberOfChannels,
        numberOfFrames: chunk.numberOfFrames,
        samples: chunk.samples
      },
      [chunk.samples.buffer]
    );
    return sequence;
  }

  // Drops all queued audio, and reports the given media time (in microseconds)
  // until new audio arrives.
  flush(mediaTime: number): void {
    this.#epoch++;
    this.#sequence = 0;
    // Pin the clock at the flushed position until the worklet confirms.
    if (!this.failed) {
      this.#anchor = {
        mediaTime: mediaTime / 1e6,
        contextTime: this.#getContextTime(),
        effectiveRate: 0
      };
    }
    this.#post({ type: "flush", epoch: this.#epoch, mediaTime });
  }

  setPlaybackRate(playbackRate: number): void {
    if (playbackRate === this.#playbackRate) {
      return;
    }
    this.#playbackRate = playbackRate;
    // Re-anchor immediately. Otherwise we'd keep extrapolating at the old rate
    // until the worklet confirms, which is very visible when flipping direction.
    const mediaTime = this.getPosition();
    if (mediaTime !== undefined) {
      this.#anchor = {
        mediaTime,
        contextTime: this.#getContextTime(),
        effectiveRate: playbackRate
      };
    }
    this.#post({ type: "playback-rate", epoch: this.#epoch, playbackRate });
  }

  // Returns the current playback position in seconds,
  // or undefined if the audio clock cannot be used right now.
  getPosition(): number | undefined {
    if (this.#anchor === undefined || this.#clock?.state !== "running") {
      return undefined;
    }
    const elapsed = Math.max(
      0,
      this.#getContextTime() - this.#anchor.contextTime
    );
    return this.#anchor.mediaTime + this.#anchor.effectiveRate * elapsed;
  }

  close(): void {
    this.#post({ type: "close" });
    this.#closed = true;
    this.#anchor = undefined;
    this.#port.close();
  }
}
