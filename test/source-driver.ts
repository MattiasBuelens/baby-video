// Drives a BabyMediaSource for the tests, on the main thread or in a worker
// (see source-driver-worker.ts). Use attachSource() from attach-source.ts
// to set one up.
import type { BabyMediaSource, BabySourceBuffer } from "../src/worker";
import { waitForEvent } from "../src/util";
import audioUrl from "./fixtures/sine-440.m4a?url";
import videoUrl from "./fixtures/video.m4v?url";

export type SourceCommand =
  | { type: "wait-for-open" }
  | { type: "append-media"; corruptVideoConfig?: boolean }
  | { type: "fail-video-decoder" }
  | { type: "append-wrong-init-segment" }
  | { type: "append-media-again"; track?: "video" | "audio" }
  | { type: "remove"; track: "video" | "audio"; start: number; end: number }
  | { type: "end-of-stream"; error?: "network" | "decode" };

// Decoders are quite forgiving about corrupted data, so make them fail on
// purpose instead. Once enabled, the next decode() fails like a real decoder
// error: the decoder closes itself, and then calls its error callback.
// https://w3c.github.io/webcodecs/#close-videodecoder
let failingVideoDecoders = false;
const OriginalVideoDecoder = VideoDecoder;
globalThis.VideoDecoder = class extends OriginalVideoDecoder {
  readonly #onError: (error: DOMException) => void;

  constructor(init: VideoDecoderInit) {
    super(init);
    this.#onError = init.error;
  }

  decode(chunk: EncodedVideoChunk): void {
    if (failingVideoDecoders && this.state === "configured") {
      this.close();
      const error = new DOMException("Injected decoder error", "EncodingError");
      queueMicrotask(() => this.#onError(error));
      return;
    }
    super.decode(chunk);
  }
};

export class SourceDriver {
  readonly #mediaSource: BabyMediaSource;

  constructor(mediaSource: BabyMediaSource) {
    this.#mediaSource = mediaSource;
  }

  async run(command: SourceCommand): Promise<void> {
    switch (command.type) {
      case "wait-for-open":
        return this.#waitForOpen();
      case "append-media":
        return this.#appendMedia(command.corruptVideoConfig ?? false);
      case "fail-video-decoder":
        failingVideoDecoders = true;
        return;
      case "append-wrong-init-segment":
        return this.#appendWrongInitSegment();
      case "append-media-again":
        return this.#appendMediaAgain(command.track);
      case "remove":
        return this.#remove(command.track, command.start, command.end);
      case "end-of-stream":
        this.#mediaSource.endOfStream(command.error);
        return;
    }
  }

  async #waitForOpen(): Promise<void> {
    if (this.#mediaSource.readyState !== "open") {
      await waitForEvent(this.#mediaSource, "sourceopen");
    }
  }

  async #appendMedia(corruptVideoConfig: boolean): Promise<void> {
    const video = new Uint8Array(await (await fetch(videoUrl)).arrayBuffer());
    if (corruptVideoConfig) {
      // Break the AVCDecoderConfigurationRecord: its version must be 1.
      // The demuxer doesn't care, but VideoDecoder.isConfigSupported() does.
      const avcC = indexOf(video, "avcC");
      video[avcC + 4] = 0;
    }
    const audio = await (await fetch(audioUrl)).arrayBuffer();
    // Add both SourceBuffers first, so the element only gets its metadata
    // once both of them received their initialization segment.
    const videoSourceBuffer = this.#mediaSource.addSourceBuffer(
      'video/mp4; codecs="avc1.64000d"'
    );
    const audioSourceBuffer = this.#mediaSource.addSourceBuffer(
      'audio/mp4; codecs="mp4a.40.2"'
    );
    await append(audioSourceBuffer, audio);
    await append(videoSourceBuffer, video.buffer);
  }

  // Appends the same media again to the existing SourceBuffers,
  // or only to the one for the given track.
  // (This reopens an ended MediaSource.)
  async #appendMediaAgain(track?: "video" | "audio"): Promise<void> {
    const [videoSourceBuffer, audioSourceBuffer] =
      this.#mediaSource.sourceBuffers;
    if (track !== "video") {
      const audio = await (await fetch(audioUrl)).arrayBuffer();
      await append(audioSourceBuffer, audio);
    }
    if (track !== "audio") {
      const video = await (await fetch(videoUrl)).arrayBuffer();
      await append(videoSourceBuffer, video);
    }
  }

  async #remove(
    track: "video" | "audio",
    start: number,
    end: number
  ): Promise<void> {
    const [videoSourceBuffer, audioSourceBuffer] =
      this.#mediaSource.sourceBuffers;
    const sourceBuffer =
      track === "video" ? videoSourceBuffer : audioSourceBuffer;
    sourceBuffer.remove(start, end);
    await waitForEvent(sourceBuffer, "updateend");
  }

  async #appendWrongInitSegment(): Promise<void> {
    // An initialization segment with an audio track, where the first one only
    // had a video track. That's an append error.
    // https://w3c.github.io/media-source/#sourcebuffer-init-segment-received (step 3.1)
    const audio = await (await fetch(audioUrl)).arrayBuffer();
    await append(this.#mediaSource.sourceBuffers[0], audio);
  }
}

async function append(
  sourceBuffer: BabySourceBuffer,
  data: ArrayBuffer
): Promise<void> {
  sourceBuffer.appendBuffer(data);
  await waitForEvent(sourceBuffer, "updateend");
}

function indexOf(data: Uint8Array, fourcc: string): number {
  const bytes = [...fourcc].map((c) => c.charCodeAt(0));
  for (let i = 0; i < data.length - 3; i++) {
    if (bytes.every((byte, j) => data[i + j] === byte)) {
      return i;
    }
  }
  throw new Error(`${fourcc} not found`);
}
