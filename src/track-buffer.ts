import { TimeRanges } from "./time-ranges";
import { Sample } from "mp4box";
import { Direction, insertSorted } from "./util";

const BUFFERED_TOLERANCE: number = 1 / 60;

export type EncodedChunk = EncodedAudioChunk | EncodedVideoChunk;
export type DecoderConfig = AudioDecoderConfig | VideoDecoderConfig;

export interface DecodeQueue {
  frames: EncodedChunk[];
  codecConfig: DecoderConfig;
}

export abstract class TrackBuffer<T extends EncodedChunk = EncodedChunk> {
  readonly type: "audio" | "video";
  readonly trackId: number;
  protected codecConfig: DecoderConfig;
  lastDecodeTimestamp: number | undefined = undefined;
  lastFrameDuration: number | undefined = undefined;
  highestEndTimestamp: number | undefined = undefined;
  needRandomAccessPoint: boolean = true;
  trackBufferRanges: TimeRanges = new TimeRanges([]);

  protected constructor(
    type: "audio" | "video",
    trackId: number,
    codecConfig: DecoderConfig
  ) {
    this.type = type;
    this.trackId = trackId;
    this.codecConfig = codecConfig;
  }

  requireRandomAccessPoint(): void {
    this.lastDecodeTimestamp = undefined;
    this.lastFrameDuration = undefined;
    this.highestEndTimestamp = undefined;
    this.needRandomAccessPoint = true;
  }

  reconfigure(newConfig: DecoderConfig): void {
    this.codecConfig = newConfig;
  }

  addSample(sample: Sample): void {
    // https://w3c.github.io/media-source/#sourcebuffer-coded-frame-processing
    // 1.1. Let presentation timestamp be a double precision floating point representation
    //      of the coded frame's presentation timestamp in seconds.
    const pts = sample.cts / sample.timescale;
    // 1.2. Let decode timestamp be a double precision floating point representation
    //      of the coded frame's decode timestamp in seconds.
    const dts = sample.dts / sample.timescale;
    // 2. Let frame duration be a double precision floating point representation
    //    of the coded frame's duration in seconds.
    const frameDuration = sample.duration / sample.timescale;
    // 7. Let frame end timestamp equal the sum of presentation timestamp and frame duration.
    const frameEndTimestamp = (sample.cts + sample.duration) / sample.timescale;
    // 16. Add the coded frame with the presentation timestamp, decode timestamp,
    //     and frame duration to the track buffer.
    this.addCodedFrame(sample);
    this.trackBufferRanges = this.trackBufferRanges.union(
      new TimeRanges([[pts, frameEndTimestamp]]),
      BUFFERED_TOLERANCE
    );
    // 17. Set last decode timestamp for track buffer to decode timestamp.
    this.lastDecodeTimestamp = dts;
    // 18. Set last frame duration for track buffer to frame duration.
    this.lastFrameDuration = frameDuration;
    // 19. If highest end timestamp for track buffer is unset or frame end timestamp
    //     is greater than highest end timestamp, then set highest end timestamp
    //     for track buffer to frame end timestamp.
    if (
      this.highestEndTimestamp === undefined ||
      frameEndTimestamp > this.highestEndTimestamp
    ) {
      this.highestEndTimestamp = frameEndTimestamp;
    }
  }

  protected abstract addCodedFrame(sample: Sample): void;

  abstract findFrameForTime(time: number): T | undefined;

  abstract getDecodeDependenciesForFrame(frame: T): DecodeQueue;

  abstract getNextFrames(
    frame: T,
    maxAmount: number,
    direction: Direction
  ): DecodeQueue | undefined;

  abstract getRandomAccessPointAtOrAfter(
    timeInMicros: number
  ): number | undefined;

  abstract removeSamples(startInMicros: number, endInMicros: number): void;
}

export interface AudioDecodeQueue extends DecodeQueue {
  frames: EncodedAudioChunk[];
  codecConfig: AudioDecoderConfig;
}

export class AudioTrackBuffer extends TrackBuffer<EncodedAudioChunk> {
  protected declare codecConfig: AudioDecoderConfig;
  #frames: EncodedAudioChunk[] = [];

  constructor(trackId: number, codecConfig: AudioDecoderConfig) {
    super("audio", trackId, codecConfig);
  }

  protected addCodedFrame(sample: Sample): void {
    // FIXME Store codecConfig
    const frame = new EncodedAudioChunk({
      timestamp: (1e6 * sample.cts) / sample.timescale,
      duration: (1e6 * sample.duration) / sample.timescale,
      data: sample.data,
      type: sample.is_sync ? "key" : "delta"
    });
    insertSorted(this.#frames, frame, (x) => x.timestamp);
  }

  findFrameForTime(time: number): EncodedAudioChunk | undefined {
    const timeInMicros = time * 1e6;
    return this.#frames.find(
      (frame) =>
        frame.timestamp <= timeInMicros &&
        timeInMicros < frame.timestamp + frame.duration!
    );
  }

  getDecodeDependenciesForFrame(frame: EncodedAudioChunk): AudioDecodeQueue {
    return {
      frames: [frame],
      codecConfig: this.codecConfig
    };
  }

  getNextFrames(
    frame: EncodedAudioChunk,
    maxAmount: number,
    _direction: Direction
  ): DecodeQueue | undefined {
    const frameIndex = this.#frames.indexOf(frame);
    if (frameIndex < 0 || frameIndex === this.#frames.length - 1) {
      return undefined;
    }
    const nextIndex = frameIndex + 1;
    return {
      frames: this.#frames.slice(nextIndex, nextIndex + maxAmount),
      codecConfig: this.codecConfig
    };
  }

  getRandomAccessPointAtOrAfter(timeInMicros: number): number | undefined {
    return this.#frames.find((frame) => frame.timestamp! >= timeInMicros)
      ?.timestamp;
  }

  removeSamples(startInMicros: number, endInMicros: number): void {
    let didRemove: boolean = false;
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      const frame = this.#frames[i];
      if (frame.timestamp >= startInMicros && frame.timestamp < endInMicros) {
        this.#frames.splice(i, 1);
        didRemove = true;
      }
    }
    if (didRemove) {
      this.#updateTrackBufferRanges();
    }
  }

  #updateTrackBufferRanges(): void {
    this.trackBufferRanges = new TimeRanges(
      this.#frames.map((frame) => [
        frame.timestamp! / 1e6,
        (frame.timestamp! + frame.duration!) / 1e6
      ])
    ).mergeOverlaps(BUFFERED_TOLERANCE);
  }
}

export interface VideoDecodeQueue extends DecodeQueue {
  frames: EncodedVideoChunk[];
  codecConfig: VideoDecoderConfig;
}

interface GroupOfPictures {
  start: number;
  end: number;
  frames: EncodedVideoChunk[];
  codecConfig: VideoDecoderConfig;
}

export class VideoTrackBuffer extends TrackBuffer<EncodedVideoChunk> {
  protected declare codecConfig: VideoDecoderConfig;
  #gops: Array<GroupOfPictures> = [];
  #currentGop: GroupOfPictures | undefined = undefined;

  constructor(trackId: number, codecConfig: VideoDecoderConfig) {
    super("video", trackId, codecConfig);
  }

  protected addCodedFrame(sample: Sample): void {
    const frame = new EncodedVideoChunk({
      timestamp: (1e6 * sample.cts) / sample.timescale,
      duration: (1e6 * sample.duration) / sample.timescale,
      data: sample.data,
      type: sample.is_sync ? "key" : "delta"
    });
    if (this.#currentGop === undefined || frame.type === "key") {
      const gop: GroupOfPictures = {
        start: frame.timestamp,
        end: frame.timestamp + frame.duration!,
        frames: [frame],
        codecConfig: this.codecConfig
      };
      this.#currentGop = gop;
      insertSorted(this.#gops, gop, (x) => x.start);
    } else {
      this.#currentGop.end = Math.max(
        this.#currentGop.end,
        frame.timestamp + frame.duration!
      );
      this.#currentGop.frames.push(frame);
    }
  }

  requireRandomAccessPoint(): void {
    super.requireRandomAccessPoint();
    this.#currentGop = undefined;
  }

  reconfigure(newConfig: VideoDecoderConfig): void {
    super.reconfigure(newConfig);
    this.#currentGop = undefined;
  }

  findFrameForTime(time: number): EncodedVideoChunk | undefined {
    const timeInMicros = time * 1e6;
    const containingGop = this.#gops.find((gop) => {
      return gop.start <= timeInMicros && timeInMicros < gop.end;
    });
    if (!containingGop) {
      return undefined;
    }
    return containingGop.frames.find(
      (sample) =>
        sample.timestamp <= timeInMicros &&
        timeInMicros < sample.timestamp + sample.duration!
    );
  }

  getDecodeDependenciesForFrame(frame: EncodedVideoChunk): VideoDecodeQueue {
    const containingGop = this.#gops.find((gop) => {
      return gop.frames.includes(frame);
    })!;
    // Decode from the first frame in the GOP (i.e. the sync frame)
    // up to (and including) the requested frame.
    let startIndex = 0;
    let endIndex = containingGop.frames.indexOf(frame);
    return {
      frames: containingGop.frames.slice(startIndex, endIndex + 1),
      codecConfig: containingGop.codecConfig
    };
  }

  getNextFrames(
    frame: EncodedVideoChunk,
    maxAmount: number,
    direction: Direction
  ): DecodeQueue | undefined {
    let gopIndex = this.#gops.findIndex((gop) => {
      return gop.frames.includes(frame);
    })!;
    if (gopIndex < 0) {
      return undefined;
    }
    let containingGop = this.#gops[gopIndex];
    let frameIndex = containingGop.frames.indexOf(frame);
    let nextGop: GroupOfPictures;
    let nextIndex: number;
    if (direction === Direction.FORWARD) {
      if (frameIndex < containingGop.frames.length - 1) {
        nextGop = containingGop;
        nextIndex = frameIndex + 1;
      } else {
        nextGop = this.#gops[gopIndex + 1];
        if (!nextGop || Math.abs(nextGop.start - containingGop.end) > 1) {
          return undefined;
        }
        nextIndex = 0;
      }
      return {
        frames: nextGop.frames.slice(nextIndex, nextIndex + maxAmount),
        codecConfig: nextGop.codecConfig
      };
    } else {
      if (frameIndex > 0) {
        nextGop = containingGop;
        nextIndex = frameIndex;
      } else {
        nextGop = this.#gops[gopIndex - 1];
        if (!nextGop || Math.abs(nextGop.end - containingGop.start) > 1) {
          return undefined;
        }
        nextIndex = nextGop.frames.length;
      }
      return {
        frames: nextGop.frames.slice(0, nextIndex),
        codecConfig: nextGop.codecConfig
      };
    }
  }

  getRandomAccessPointAtOrAfter(timeInMicros: number): number | undefined {
    return this.#gops.find((gop) => gop.start >= timeInMicros)?.start;
  }

  removeSamples(startInMicros: number, endInMicros: number): void {
    // https://w3c.github.io/media-source/#dfn-coded-frame-removal
    // 3.3. Remove all media data, from this track buffer, that contain starting timestamps
    //      greater than or equal to start and less than the remove end timestamp.
    // 3.4. Remove all possible decoding dependencies on the coded frames removed
    //      in the previous step by removing all coded frames from this track buffer
    //      between those frames removed in the previous step and the next random
    //      access point after those removed frames.
    let didRemove: boolean = false;
    for (let i = this.#gops.length - 1; i >= 0; i--) {
      const gop = this.#gops[i];
      const removeFrom = gop.frames.findIndex(
        (frame) =>
          frame.timestamp >= startInMicros && frame.timestamp < endInMicros
      );
      if (removeFrom < 0) {
        // Keep entire GOP.
      } else if (removeFrom === 0) {
        // Remove entire GOP.
        this.#gops.splice(i, 1);
        didRemove = true;
      } else {
        // Remove some frames.
        const lastFrame = gop.frames[removeFrom - 1];
        gop.end = lastFrame.timestamp! + lastFrame.duration!;
        gop.frames.splice(removeFrom);
        didRemove = true;
      }
    }
    if (didRemove) {
      this.#updateTrackBufferRanges();
    }
  }

  #updateTrackBufferRanges(): void {
    this.trackBufferRanges = new TimeRanges(
      this.#gops.map((gop) => [gop.start / 1e6, gop.end / 1e6])
    ).mergeOverlaps(BUFFERED_TOLERANCE);
  }
}
