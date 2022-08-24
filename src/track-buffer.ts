export abstract class TrackBuffer {
  trackId: number;
  codecConfig: AudioDecoderConfig | VideoDecoderConfig;

  protected constructor(
    trackId: number,
    codecConfig: AudioDecoderConfig | VideoDecoderConfig
  ) {
    this.trackId = trackId;
    this.codecConfig = codecConfig;
  }
}

export class AudioTrackBuffer extends TrackBuffer {
  declare codecConfig: AudioDecoderConfig;

  constructor(trackId: number, codecConfig: AudioDecoderConfig) {
    super(trackId, codecConfig);
  }
}

export class VideoTrackBuffer extends TrackBuffer {
  declare codecConfig: VideoDecoderConfig;

  constructor(trackId: number, codecConfig: VideoDecoderConfig) {
    super(trackId, codecConfig);
  }
}
