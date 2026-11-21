// The interface between a BabyMediaSource and the media element it is attached to.
//
// The MediaSource only talks to the media element through this interface, and
// never imports the element itself. That keeps media-source.ts and
// source-buffer.ts free of DOM dependencies, which is a prerequisite for
// running them in a worker.

export enum MediaReadyState {
  HAVE_NOTHING,
  HAVE_METADATA,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_ENOUGH_DATA
}

export interface MediaSourceAttachment {
  // HTMLMediaElement.readyState
  readonly readyState: MediaReadyState;
  // HTMLMediaElement.currentTime, in seconds
  readonly currentTime: number;
  // HTMLMediaElement.playbackRate
  readonly playbackRate: number;
  // Runs the HTMLMediaElement duration change algorithm.
  updateDuration(newDuration: number): void;
  // Sets HTMLMediaElement.readyState.
  updateReadyState(newReadyState: MediaReadyState): void;
  // Notifies the media element that new media data was appended.
  notifyProgress(): void;
  // Notifies the media element that it now has all of the media data.
  notifyEndOfStream(): void;
}
