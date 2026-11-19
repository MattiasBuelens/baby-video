import audioSinkWorkletUrl from "./audio-sink-processor.ts?worker&url";
import type {
  AudioSinkDirection,
  AudioSinkInboundMessage,
  AudioSinkProcessorName,
  AudioSinkStatusMessage
} from "./audio-sink-messages";

const processorName: AudioSinkProcessorName = "audio-sink";

export interface BabyAudioSinkInit {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly onStatus: (status: AudioSinkStatusMessage) => void;
  readonly onReady: () => void;
  readonly onStateChange: (state: AudioContextState) => void;
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

// Plays back decoded audio through an AudioWorklet.
//
// The worklet owns the sample queue, so the main thread merely has to push
// decoded audio ahead of time. It also owns the playback position: it reports
// an anchor { mediaTime, contextTime, effectiveRate } which the main thread
// extrapolates with AudioContext.currentTime, which is exact for as long as the
// effective rate stays constant.
export class BabyAudioSink {
  readonly #context: AudioContext;
  readonly #gainNode: GainNode;
  readonly #onStatus: (status: AudioSinkStatusMessage) => void;
  readonly #onReady: () => void;
  readonly #onStateChange: (state: AudioContextState) => void;
  readonly #numberOfChannels: number;

  #node: AudioWorkletNode | undefined;
  #failed: boolean = false;
  #closed: boolean = false;
  #epoch: number = 0;
  #sequence: number = 0;
  #playbackRate: number = 1;
  #gain: number = 1;
  #anchor: AudioSinkAnchor | undefined;

  constructor(init: BabyAudioSinkInit) {
    this.#onStatus = init.onStatus;
    this.#onReady = init.onReady;
    this.#onStateChange = init.onStateChange;
    this.#numberOfChannels = init.numberOfChannels;

    this.#context = new AudioContext({
      sampleRate: init.sampleRate,
      latencyHint: "playback"
    });
    this.#context.addEventListener("statechange", () => {
      this.#onStateChange(this.#context.state);
    });

    this.#gainNode = new GainNode(this.#context, { gain: this.#gain });
    this.#gainNode.connect(this.#context.destination);

    this.#context.audioWorklet
      .addModule(audioSinkWorkletUrl)
      .then(() => this.#onModuleLoaded())
      .catch((error) => this.#onModuleFailed(error));
  }

  get isReady(): boolean {
    return this.#node !== undefined;
  }

  get failed(): boolean {
    return this.#failed;
  }

  get sampleRate(): number {
    return this.#context.sampleRate;
  }

  get numberOfChannels(): number {
    return this.#numberOfChannels;
  }

  #onModuleLoaded(): void {
    if (this.#closed) {
      return;
    }
    this.#node = new AudioWorkletNode(this.#context, processorName, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.#numberOfChannels]
    });
    this.#node.port.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data as AudioSinkStatusMessage);
    };
    this.#node.connect(this.#gainNode);
    // Bring the worklet up to date with everything that happened
    // while the module was still loading.
    this.#post({
      type: "flush",
      epoch: this.#epoch,
      mediaTime: Math.round(1e6 * (this.#anchor?.mediaTime ?? 0))
    });
    this.#post({
      type: "playback-rate",
      epoch: this.#epoch,
      playbackRate: this.#playbackRate
    });
    this.#onReady();
  }

  #onModuleFailed(error: unknown): void {
    // Without a worklet there can be no audio and no audio clock. Give up
    // permanently: the video element then falls back to the wall clock.
    console.error("Failed to load the audio worklet module", error);
    this.#failed = true;
    this.#anchor = undefined;
  }

  #onMessage(status: AudioSinkStatusMessage): void {
    // Statuses produced before the worklet saw our latest flush are stale:
    // accepting one would rewind the clock to before the seek.
    if (status.epoch !== this.#epoch) {
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
    this.#node?.port.postMessage(message, transfer ?? []);
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
    // Bump the epoch even if the worklet does not exist yet, so that any audio
    // pushed before this flush can never be played.
    this.#epoch++;
    this.#sequence = 0;
    // Pin the clock at the flushed position until the worklet confirms.
    this.#anchor = {
      mediaTime: mediaTime / 1e6,
      contextTime: this.#context.currentTime,
      effectiveRate: 0
    };
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
        contextTime: this.#context.currentTime,
        effectiveRate: playbackRate
      };
    }
    this.#post({ type: "playback-rate", epoch: this.#epoch, playbackRate });
  }

  setGain(gain: number): void {
    this.#gain = gain;
    this.#gainNode.gain.value = gain;
  }

  // Returns the current playback position in seconds,
  // or undefined if the audio clock cannot be used right now.
  getPosition(): number | undefined {
    if (this.#anchor === undefined || this.#context.state !== "running") {
      return undefined;
    }
    const elapsed = Math.max(
      0,
      this.#context.currentTime - this.#anchor.contextTime
    );
    return this.#anchor.mediaTime + this.#anchor.effectiveRate * elapsed;
  }

  resume(): void {
    void this.#context.resume();
  }

  suspend(): void {
    void this.#context.suspend();
  }

  close(): void {
    this.#closed = true;
    this.#post({ type: "close" });
    this.#node?.disconnect();
    this.#node = undefined;
    this.#anchor = undefined;
    void this.#context.close();
  }
}
