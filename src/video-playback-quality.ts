// https://w3c.github.io/media-playback-quality/#videoplaybackquality-interface
// Returned by BabyVideoElement.getVideoPlaybackQuality().
export class BabyVideoPlaybackQuality {
  readonly #creationTime: number;
  readonly #droppedVideoFrames: number;
  readonly #totalVideoFrames: number;

  constructor(
    creationTime: number,
    droppedVideoFrames: number,
    totalVideoFrames: number
  ) {
    this.#creationTime = creationTime;
    this.#droppedVideoFrames = droppedVideoFrames;
    this.#totalVideoFrames = totalVideoFrames;
  }

  // The current high resolution time for when this object was created.
  get creationTime(): number {
    return this.#creationTime;
  }

  // The total number of frames dropped predecode or dropped because
  // the frame missed its display deadline.
  get droppedVideoFrames(): number {
    return this.#droppedVideoFrames;
  }

  // The total number of frames that would have been displayed
  // if no frames are dropped.
  get totalVideoFrames(): number {
    return this.#totalVideoFrames;
  }

  // Deprecated. We never detect corrupted frames: the decoder errors instead.
  get corruptedVideoFrames(): number {
    return 0;
  }
}
