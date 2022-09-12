import { TimeRanges } from "./time-ranges";
import { Sample } from "mp4box";

const BUFFERED_TOLERANCE: number = 1e-6;

export type EncodedChunk = EncodedAudioChunk | EncodedVideoChunk;

interface GroupOfPictures<T extends EncodedChunk> {
  start: number;
  end: number;
  frames: T[];
}

export abstract class TrackBuffer<T extends EncodedChunk = EncodedChunk> {
  readonly trackId: number;
  codecConfig: AudioDecoderConfig | VideoDecoderConfig;
  lastDecodeTimestamp: number | undefined = undefined;
  lastFrameDuration: number | undefined = undefined;
  highestEndTimestamp: number | undefined = undefined;
  needRandomAccessPoint: boolean = true;
  trackBufferRanges: TimeRanges = new TimeRanges([]);
  #gops: Array<GroupOfPictures<T>> = [];
  #currentGop: GroupOfPictures<T> | undefined = undefined;

  protected constructor(
    trackId: number,
    codecConfig: AudioDecoderConfig | VideoDecoderConfig
  ) {
    this.trackId = trackId;
    this.codecConfig = codecConfig;
  }

  requireRandomAccessPoint(): void {
    this.lastDecodeTimestamp = undefined;
    this.lastFrameDuration = undefined;
    this.highestEndTimestamp = undefined;
    this.needRandomAccessPoint = true;
    this.#currentGop = undefined;
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
    const frame = this.createFrame(sample);
    if (this.#currentGop === undefined || frame.type === "key") {
      this.#currentGop = {
        start: frame.timestamp,
        end: frame.timestamp + frame.duration!,
        frames: [frame],
      };
      this.#gops.push(this.#currentGop);
      this.#gops.sort(compareGopByStart);
    } else {
      this.#currentGop.end = Math.max(
        this.#currentGop.end,
        frame.timestamp + frame.duration!
      );
      this.#currentGop.frames.push(frame);
    }
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

  protected abstract createFrame(sample: Sample): T;

  findFrameForTime(time: number): T | undefined {
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

  getDecodeQueueForFrame(frame: T, lastDecodedFrame: T | undefined): T[] {
    const containingGop = this.#gops.find((gop) => {
      return gop.frames.includes(frame);
    })!;
    // By default, decode from the first frame in the GOP (i.e. the sync frame)
    // up to (and including) the requested frame.
    let startIndex = 0;
    let endIndex = containingGop.frames.indexOf(frame);
    if (lastDecodedFrame !== undefined) {
      const lastDecodedFrameIndex =
        containingGop.frames.indexOf(lastDecodedFrame);
      // If last decoded frame is inside same GOP and precedes the requested frame,
      // decode starting from the last decode frame.
      if (lastDecodedFrameIndex >= 0 && lastDecodedFrameIndex < endIndex) {
        startIndex = lastDecodedFrameIndex + 1;
      }
    }
    return containingGop.frames.slice(startIndex, endIndex + 1);
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
        this.trackBufferRanges = this.trackBufferRanges.subtract(
          new TimeRanges([[gop.start / 1e6, gop.end / 1e6]])
        );
      } else {
        // Remove some frames.
        const lastFrame = gop.frames[removeFrom - 1];
        const oldEnd = gop.end;
        gop.end = lastFrame.timestamp! + lastFrame.duration!;
        gop.frames.splice(removeFrom);
        this.trackBufferRanges = this.trackBufferRanges.subtract(
          new TimeRanges([[gop.end / 1e6, oldEnd / 1e6]])
        );
      }
    }
  }
}

export class AudioTrackBuffer extends TrackBuffer<EncodedAudioChunk> {
  declare codecConfig: AudioDecoderConfig;

  constructor(trackId: number, codecConfig: AudioDecoderConfig) {
    super(trackId, codecConfig);
  }

  protected createFrame(sample: Sample): EncodedAudioChunk {
    return new EncodedAudioChunk({
      timestamp: (1e6 * sample.cts) / sample.timescale,
      duration: (1e6 * sample.duration) / sample.timescale,
      data: sample.data,
      type: sample.is_sync ? "key" : "delta",
    });
  }
}

export class VideoTrackBuffer extends TrackBuffer<EncodedVideoChunk> {
  declare codecConfig: VideoDecoderConfig;

  constructor(trackId: number, codecConfig: VideoDecoderConfig) {
    super(trackId, codecConfig);
  }

  protected createFrame(sample: Sample): EncodedVideoChunk {
    return new EncodedVideoChunk({
      timestamp: (1e6 * sample.cts) / sample.timescale,
      duration: (1e6 * sample.duration) / sample.timescale,
      data: sample.data,
      type: sample.is_sync ? "key" : "delta",
    });
  }
}

function compareGopByStart<T extends EncodedChunk>(
  left: GroupOfPictures<T>,
  right: GroupOfPictures<T>
): number {
  return left.start - right.start;
}
