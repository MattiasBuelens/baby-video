import type {
  AudioSinkDirection,
  AudioSinkInboundMessage,
  AudioSinkProcessorName,
  AudioSinkPushMessage,
  AudioSinkStatusMessage
} from "./audio-sink-messages";

// AudioWorkletGlobalScope is not covered by "lib.dom". The @types/audioworklet
// package declares these globally, i.e. in *every* file of the program, which is
// too dangerous in a codebase full of `currentTime` and `sampleRate` locals.
// Since this file is a module, these declarations are local to it.
declare const sampleRate: number;
declare const currentTime: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(
  name: string,
  processorCtor: new (
    options?: AudioWorkletNodeOptions
  ) => AudioWorkletProcessor
): void;

// Post a status message at least every this many output samples.
// A render quantum is only 128 samples, so posting one per quantum would be
// ~375 messages per second. Extrapolation between anchors is exact while the
// effective rate is constant, so a much lower rate is enough: 2048 samples is
// 16 whole quanta, or about 43ms at 48kHz.
const anchorIntervalFrames = 2048;

interface SinkChunk {
  readonly sequence: number;
  // Media time of sample 0, in microseconds.
  readonly headMediaTime: number;
  readonly direction: AudioSinkDirection;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  // One Float32Array per channel, viewing into the transferred sample buffer.
  readonly planes: Float32Array[];
}

class AudioSinkProcessor extends AudioWorkletProcessor {
  #queue: SinkChunk[] = [];
  // Read position within the first queued chunk, in (fractional) samples.
  #readIndex: number = 0;
  #epoch: number = 0;
  #playbackRate: number = 1;
  // Media time of the next sample to be rendered, in microseconds.
  #mediaTime: number = 0;
  #lastConsumedSequence: number = -1;
  #queuedSeconds: number = 0;
  #framesSinceAnchor: number = 0;
  #wasStarved: boolean = false;
  #closed: boolean = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data as AudioSinkInboundMessage);
    };
  }

  #onMessage(message: AudioSinkInboundMessage): void {
    switch (message.type) {
      case "push":
        if (message.epoch !== this.#epoch) {
          return;
        }
        this.#queue.push(toSinkChunk(message));
        this.#queuedSeconds += message.numberOfFrames / message.sampleRate;
        break;
      case "flush":
        this.#epoch = message.epoch;
        this.#queue.length = 0;
        this.#readIndex = 0;
        this.#queuedSeconds = 0;
        this.#mediaTime = message.mediaTime;
        this.#lastConsumedSequence = -1;
        this.#postStatus(0, false);
        break;
      case "playback-rate":
        if (message.epoch !== this.#epoch) {
          return;
        }
        this.#playbackRate = message.playbackRate;
        this.#postStatus(0, false);
        break;
      case "close":
        this.#closed = true;
        this.#queue.length = 0;
        this.#queuedSeconds = 0;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.#closed) {
      return false;
    }
    const output = outputs[0];
    const outputChannels = output.length;
    const quantumSize = outputChannels > 0 ? output[0].length : 0;
    const playbackRate = this.#playbackRate;

    let rendered = 0;
    if (playbackRate !== 0) {
      while (rendered < quantumSize) {
        const chunk = this.#readableChunk();
        if (chunk === undefined) {
          // Starved: we ran out of queued audio.
          break;
        }
        // Source samples consumed per output sample. Recomputed on every
        // iteration, since the head chunk can change in the middle of a quantum
        // and may have a different sample rate.
        const step = (chunk.sampleRate / sampleRate) * Math.abs(playbackRate);
        const index = this.#readIndex | 0;
        const fraction = this.#readIndex - index;
        // When interpolating across a chunk boundary, we need the first sample
        // of the next chunk. If there is none, we hold the last sample instead,
        // which is at most one sample of error.
        const next =
          fraction !== 0 && index + 1 >= chunk.numberOfFrames
            ? this.#queue[1]
            : undefined;
        for (let channel = 0; channel < outputChannels; channel++) {
          const plane = planeOf(chunk, channel);
          const start = plane[index];
          const end =
            index + 1 < chunk.numberOfFrames
              ? plane[index + 1]
              : next !== undefined
                ? planeOf(next, channel)[0]
                : start;
          output[channel][rendered] = start + (end - start) * fraction;
        }
        this.#readIndex += step;
        // Always recompute the media time from the head chunk's own timestamp,
        // rather than accumulating it, so it can never drift.
        this.#mediaTime =
          chunk.headMediaTime +
          chunk.direction * (this.#readIndex / chunk.sampleRate) * 1e6;
        rendered++;
      }
    }

    // Fill the rest with silence, if we're starved or stopped.
    for (let channel = 0; channel < outputChannels; channel++) {
      output[channel].fill(0, rendered);
    }

    const starved = playbackRate !== 0 && rendered < quantumSize;
    this.#framesSinceAnchor += quantumSize;
    if (
      this.#framesSinceAnchor >= anchorIntervalFrames ||
      starved !== this.#wasStarved
    ) {
      this.#wasStarved = starved;
      this.#postStatus(quantumSize, starved);
    }
    // Never return false: an empty queue is a normal transient state, and
    // returning false would permanently release this node.
    return true;
  }

  // Drops fully consumed chunks off the head of the queue,
  // and returns the chunk to read from (if any).
  #readableChunk(): SinkChunk | undefined {
    while (this.#queue.length > 0) {
      const chunk = this.#queue[0];
      if (this.#readIndex < chunk.numberOfFrames) {
        return chunk;
      }
      this.#readIndex -= chunk.numberOfFrames;
      this.#queuedSeconds -= chunk.numberOfFrames / chunk.sampleRate;
      this.#lastConsumedSequence = chunk.sequence;
      this.#queue.shift();
    }
    return undefined;
  }

  #postStatus(quantumSize: number, starved: boolean): void {
    this.#framesSinceAnchor = 0;
    const head = this.#queue[0];
    const consumed = head !== undefined ? this.#readIndex / head.sampleRate : 0;
    const message: AudioSinkStatusMessage = {
      type: "status",
      epoch: this.#epoch,
      mediaTime: this.#mediaTime,
      // `currentTime` is the start of the quantum that was just rendered, while
      // `#mediaTime` is where the *next* output sample comes from.
      contextTime: currentTime + quantumSize / sampleRate,
      effectiveRate:
        starved || this.#playbackRate === 0 ? 0 : this.#playbackRate,
      bufferedDuration: Math.max(0, this.#queuedSeconds - consumed),
      lastConsumedSequence: this.#lastConsumedSequence,
      starved
    };
    this.port.postMessage(message);
  }
}

function toSinkChunk(message: AudioSinkPushMessage): SinkChunk {
  const { samples, numberOfChannels, numberOfFrames } = message;
  // Build the channel views up front: process() must not allocate.
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < numberOfChannels; channel++) {
    planes.push(
      samples.subarray(channel * numberOfFrames, (channel + 1) * numberOfFrames)
    );
  }
  return {
    sequence: message.sequence,
    headMediaTime: message.headMediaTime,
    direction: message.direction,
    sampleRate: message.sampleRate,
    numberOfChannels,
    numberOfFrames,
    planes
  };
}

function planeOf(chunk: SinkChunk, channel: number): Float32Array {
  // With fewer source channels than outputs (e.g. mono to stereo), repeat the
  // last channel. With more (e.g. 5.1 to stereo), take the first ones.
  return chunk.planes[Math.min(channel, chunk.numberOfChannels - 1)];
}

registerProcessor(
  "audio-sink" satisfies AudioSinkProcessorName,
  AudioSinkProcessor
);
