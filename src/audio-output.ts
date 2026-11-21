import audioSinkWorkletUrl from "./audio-sink-processor.ts?worker&url";
import type {
  AudioSinkInboundMessage,
  AudioSinkProcessorName
} from "./audio-sink-messages";
import { getAbsoluteTime } from "./util";

const processorName: AudioSinkProcessorName = "audio-sink";

// How often to send an audio clock snapshot while the context is running.
const clockSnapshotInterval = 250;

// The state of an AudioContext, as seen by the media pipeline.
export interface AudioClockSnapshot {
  // AudioContext.currentTime at `timestamp`, in seconds.
  readonly contextTime: number;
  // The time at which `contextTime` was taken, as an absolute high resolution
  // time in milliseconds (performance.timeOrigin + performance.now()).
  // Absolute, because a worker has a different time origin than its window.
  readonly timestamp: number;
  // AudioContext.state, or "failed" if the audio worklet failed to load.
  readonly state: AudioContextState | "failed";
}

export interface AudioOutputInit {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  // The pipeline's end of the port to the audio worklet.
  readonly port: MessagePort;
  readonly gain: number;
  readonly onClock: (snapshot: AudioClockSnapshot) => void;
}

// The main thread side of the audio output: the AudioContext and its audio
// graph. AudioContext only exists on the main thread, so this is created there
// on behalf of the media pipeline.
//
// The audio samples never pass through here. The pipeline sends them straight
// to the audio worklet, through a port that it creates and that this class
// hands over to the worklet (see AudioSinkConnectMessage). All this class
// does is resume or suspend the context, set the volume, and tell the pipeline
// what time it is on the audio clock.
export class AudioOutput {
  readonly #context: AudioContext;
  readonly #gainNode: GainNode;
  readonly #onClock: (snapshot: AudioClockSnapshot) => void;
  readonly #numberOfChannels: number;

  #port: MessagePort | undefined;
  #node: AudioWorkletNode | undefined;
  #failed: boolean = false;
  #closed: boolean = false;
  #clockTimer: number = 0;

  constructor(init: AudioOutputInit) {
    this.#onClock = init.onClock;
    this.#numberOfChannels = init.numberOfChannels;
    this.#port = init.port;

    this.#context = new AudioContext({
      sampleRate: init.sampleRate,
      latencyHint: "playback"
    });
    this.#context.addEventListener("statechange", () => {
      this.#updateClockTimer();
      this.#sendClock();
    });

    this.#gainNode = new GainNode(this.#context, { gain: init.gain });
    this.#gainNode.connect(this.#context.destination);

    this.#context.audioWorklet
      .addModule(audioSinkWorkletUrl)
      .then(() => this.#onModuleLoaded())
      .catch((error) => this.#onModuleFailed(error));
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
    this.#node.connect(this.#gainNode);
    // Hand the pipeline's port to the worklet. Everything the pipeline posted
    // in the meantime is still queued on it, and is delivered in order.
    const port = this.#port!;
    this.#port = undefined;
    this.#node.port.postMessage(
      { type: "connect", port } satisfies AudioSinkInboundMessage,
      [port]
    );
  }

  #onModuleFailed(error: unknown): void {
    // Without a worklet there can be no audio and no audio clock. Give up
    // permanently: the pipeline then falls back to the wall clock.
    console.error("Failed to load the audio worklet module", error);
    this.#failed = true;
    this.#port?.close();
    this.#port = undefined;
    this.#sendClock();
  }

  #sendClock(): void {
    if (this.#closed) {
      return;
    }
    this.#onClock({
      contextTime: this.#context.currentTime,
      timestamp: getAbsoluteTime(),
      state: this.#failed ? "failed" : this.#context.state
    });
  }

  // Keep sending snapshots while running, so the pipeline's estimate of the
  // audio clock doesn't drift away from the real one.
  #updateClockTimer(): void {
    const running = !this.#closed && this.#context.state === "running";
    if (running && this.#clockTimer === 0) {
      this.#clockTimer = setInterval(
        () => this.#sendClock(),
        clockSnapshotInterval
      );
    } else if (!running && this.#clockTimer !== 0) {
      clearInterval(this.#clockTimer);
      this.#clockTimer = 0;
    }
  }

  setGain(gain: number): void {
    this.#gainNode.gain.value = gain;
  }

  resume(): void {
    this.#context.resume().then(
      () => this.#sendClock(),
      () => {}
    );
  }

  suspend(): void {
    void this.#context.suspend();
  }

  close(): void {
    this.#closed = true;
    this.#updateClockTimer();
    this.#port?.close();
    this.#port = undefined;
    this.#node?.disconnect();
    this.#node = undefined;
    void this.#context.close();
  }
}
