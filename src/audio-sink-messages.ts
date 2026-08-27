// Message protocol between BabyAudioSink (main thread) and AudioSinkProcessor
// (audio thread). This module must contain *only* types: both sides import it
// with `import type`, so that the processor bundle has no runtime imports at all.

// Mirrors Direction from "./util", duplicated to keep this module free of
// runtime imports.
export type AudioSinkDirection = 1 | -1;

export type AudioSinkProcessorName = "audio-sink";

export interface AudioSinkPushMessage {
  readonly type: "push";
  readonly epoch: number;
  readonly sequence: number;
  // Media time of sample 0 of `samples`, in microseconds.
  // Forward: AudioData.timestamp.
  // Backward: AudioData.timestamp + duration, since the samples were reversed.
  readonly headMediaTime: number;
  readonly direction: AudioSinkDirection;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  // Planar f32 samples, with all planes concatenated.
  // Its ArrayBuffer is transferred, so it must not be used afterwards.
  readonly samples: Float32Array;
}

export interface AudioSinkFlushMessage {
  readonly type: "flush";
  // The new epoch. Messages with any other epoch are dropped.
  readonly epoch: number;
  // The media time to report until new data arrives, in microseconds.
  readonly mediaTime: number;
}

export interface AudioSinkPlaybackRateMessage {
  readonly type: "playback-rate";
  readonly epoch: number;
  readonly playbackRate: number;
}

export interface AudioSinkCloseMessage {
  readonly type: "close";
}

export type AudioSinkInboundMessage =
  | AudioSinkPushMessage
  | AudioSinkFlushMessage
  | AudioSinkPlaybackRateMessage
  | AudioSinkCloseMessage;

export interface AudioSinkStatusMessage {
  readonly type: "status";
  // The epoch this status describes. Stale epochs must be ignored.
  readonly epoch: number;
  // The media time at `contextTime`, in microseconds.
  readonly mediaTime: number;
  // The AudioContext time this anchor is valid at, in seconds.
  readonly contextTime: number;
  // Media seconds per context second from `contextTime` onwards, signed.
  // Equal to the playback rate while rendering, or 0 while starved or stopped.
  readonly effectiveRate: number;
  // Un-consumed audio still queued, in seconds. Always positive.
  readonly bufferedDuration: number;
  // The highest sequence number that was fully consumed, or -1 after a flush.
  readonly lastConsumedSequence: number;
  // Whether the last render quantum could not be filled from the queue.
  readonly starved: boolean;
}
