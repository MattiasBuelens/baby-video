import { TimeRanges } from "./time-ranges";
import { Sample } from "mp4box";

const BUFFERED_TOLERANCE: number = 1e-6;

export abstract class TrackBuffer {
  readonly trackId: number;
  codecConfig: AudioDecoderConfig | VideoDecoderConfig;
  lastDecodeTimestamp: number | undefined = undefined;
  lastFrameDuration: number | undefined = undefined;
  highestEndTimestamp: number | undefined = undefined;
  needRandomAccessPoint: boolean = true;
  trackBufferRanges: TimeRanges = new TimeRanges([]);

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
    this.addSampleInternal(sample);
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

  protected abstract addSampleInternal(sample: Sample): void;

  abstract findSampleForTime(time: number): Sample | undefined;

  abstract findSyncForSample(sample: Sample): Sample | undefined;
}

export class AudioTrackBuffer extends TrackBuffer {
  declare codecConfig: AudioDecoderConfig;
  #samples: Sample[] = [];

  constructor(trackId: number, codecConfig: AudioDecoderConfig) {
    super(trackId, codecConfig);
  }

  protected addSampleInternal(sample: Sample): void {
    this.#samples.push(sample);
  }

  findSampleForTime(time: number): Sample | undefined {
    return findSampleForTime(this.#samples, time);
  }

  findSyncForSample(sample: Sample): Sample | undefined {
    return sample;
  }
}

interface GroupOfPictures {
  start: number;
  end: number;
  samples: Sample[];
}

export class VideoTrackBuffer extends TrackBuffer {
  declare codecConfig: VideoDecoderConfig;
  #gops: GroupOfPictures[] = [];
  #currentGop: GroupOfPictures | undefined = undefined;

  constructor(trackId: number, codecConfig: VideoDecoderConfig) {
    super(trackId, codecConfig);
  }

  requireRandomAccessPoint(): void {
    super.requireRandomAccessPoint();
    this.#currentGop = undefined;
  }

  protected addSampleInternal(sample: Sample): void {
    if (this.#currentGop === undefined || sample.is_sync) {
      this.#currentGop = {
        start: sample.cts / sample.timescale,
        end: (sample.cts + sample.duration) / sample.timescale,
        samples: [sample],
      };
      this.#gops.push(this.#currentGop);
    } else {
      this.#currentGop.end = Math.max(
        this.#currentGop.end,
        (sample.cts + sample.duration) / sample.timescale
      );
      this.#currentGop.samples.push(sample);
    }
  }

  findSampleForTime(time: number): Sample | undefined {
    const containingGop = this.#gops.find((gop) => {
      return gop.start <= time && time < gop.end;
    });
    return containingGop && findSampleForTime(containingGop.samples, time);
  }

  findSyncForSample(sample: Sample): Sample | undefined {
    const containingGop = this.#gops.find((gop) => {
      return gop.samples.includes(sample);
    });
    return containingGop?.samples[0];
  }
}

function findSampleForTime(
  samples: readonly Sample[],
  time: number
): Sample | undefined {
  return samples.find((sample) => {
    const start = sample.cts / sample.timescale;
    const end = (sample.cts + sample.duration) / sample.timescale;
    return start <= time && time < end;
  });
}
