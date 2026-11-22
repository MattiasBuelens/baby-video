// Message protocol between a <baby-video> element (always on the main thread)
// and its media pipeline (on the main thread, or in the worker that created
// the MediaSource). This module must contain *only* types.
//
// Each side only ever talks to the other through a MessagePort,
// even when both live on the same thread.

import type { TimeRange } from "./time-ranges";
import type { MediaReadyState } from "./media-source-attachment";
import type { AudioClockSnapshot } from "./audio-output";
import type {
  MediaPipelineError,
  MediaPipelineInit,
  PresentedVideoFrame
} from "./media-pipeline";

// region Element to pipeline

export interface PipelineAttachMessage {
  readonly type: "attach";
  // The canvas to render to. Transferred.
  readonly canvas: OffscreenCanvas;
  readonly init: MediaPipelineInit;
}

export interface PipelineSetPlayingMessage {
  readonly type: "set-playing";
  // Whether the element is potentially playing and not seeking,
  // i.e. whether the playback position should advance.
  readonly playing: boolean;
}

export interface PipelineSetPlaybackRateMessage {
  readonly type: "set-playback-rate";
  readonly playbackRate: number;
}

// Bug showcase: see BabyVideoElement.bugDecodeVideoInReverse.
export interface PipelineSetBugDecodeVideoInReverseMessage {
  readonly type: "set-bug-decode-video-in-reverse";
  readonly value: boolean;
}

// https://html.spec.whatwg.org/multipage/media.html#dom-media-seek (steps 11 and 12)
export interface PipelineSeekMessage {
  readonly type: "seek";
  // Identifies this seek. Replies tagged with an older epoch are stale.
  readonly epoch: number;
  readonly time: number;
}

export interface PipelineAudioClockMessage {
  readonly type: "audio-clock";
  readonly snapshot: AudioClockSnapshot;
}

export interface PipelineDetachMessage {
  readonly type: "detach";
}

export type PipelineCommandMessage =
  | PipelineAttachMessage
  | PipelineSetPlayingMessage
  | PipelineSetPlaybackRateMessage
  | PipelineSetBugDecodeVideoInReverseMessage
  | PipelineSeekMessage
  | PipelineAudioClockMessage
  | PipelineDetachMessage;

// endregion

// region Pipeline to element

export interface PipelineReadyStateMessage {
  readonly type: "ready-state";
  readonly readyState: MediaReadyState;
}

export interface PipelineDurationMessage {
  readonly type: "duration";
  readonly duration: number;
}

export interface PipelineProgressMessage {
  readonly type: "progress";
}

// https://w3c.github.io/media-source/#htmlmediaelement-extensions-buffered
export interface PipelineBufferedMessage {
  readonly type: "buffered";
  // The new HTMLMediaElement.buffered ranges, in seconds.
  readonly ranges: TimeRange[];
}

export interface PipelineEndOfStreamMessage {
  readonly type: "end-of-stream";
}

export interface PipelineStreamReopenedMessage {
  readonly type: "stream-reopened";
}

export interface PipelineTimeUpdateMessage {
  readonly type: "time-update";
  // The epoch of the last seek the pipeline saw.
  readonly epoch: number;
  readonly currentTime: number;
  readonly isNormalPlayback: boolean;
}

export interface PipelineSeekCompleteMessage {
  readonly type: "seek-complete";
  readonly epoch: number;
}

export interface PipelineResizeMessage {
  readonly type: "resize";
  readonly width: number;
  readonly height: number;
}

// https://wicg.github.io/video-rvfc/#video-rvfc-procedures
export interface PipelineVideoFramePresentedMessage {
  readonly type: "video-frame-presented";
  readonly frame: PresentedVideoFrame;
}

// https://w3c.github.io/media-playback-quality/#concepts
export interface PipelineVideoFramesDroppedMessage {
  readonly type: "video-frames-dropped";
  readonly droppedFrames: number;
}

// https://html.spec.whatwg.org/multipage/media.html#media-data-processing-steps-list
export interface PipelineErrorMessage {
  readonly type: "error";
  readonly error: MediaPipelineError;
  readonly message: string;
}

export interface PipelineCreateAudioOutputMessage {
  readonly type: "create-audio-output";
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  // The audio worklet's end of the pipeline's audio port. Transferred.
  readonly port: MessagePort;
}

export type PipelineEventMessage =
  | PipelineReadyStateMessage
  | PipelineDurationMessage
  | PipelineProgressMessage
  | PipelineBufferedMessage
  | PipelineEndOfStreamMessage
  | PipelineStreamReopenedMessage
  | PipelineTimeUpdateMessage
  | PipelineSeekCompleteMessage
  | PipelineResizeMessage
  | PipelineVideoFramePresentedMessage
  | PipelineVideoFramesDroppedMessage
  | PipelineErrorMessage
  | PipelineCreateAudioOutputMessage;

// endregion
