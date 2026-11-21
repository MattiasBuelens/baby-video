// The demo's MediaSource, in a dedicated worker (see app.ts, with ?worker).
// The media pipeline of the <baby-video> element runs here too.
import { BabyMediaSource, BabyMediaSourceHandle } from "../src/worker";
import type { TimeRange } from "../src/time-ranges";
import { type PlaybackState, startBuffering } from "./buffering";

// Main thread to worker: the element's playback state.
export interface PlaybackStateMessage {
  readonly type: "timeupdate" | "seeking" | "ratechange";
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly loop: boolean;
}

// Worker to main thread.
export type WorkerMessage =
  | { readonly type: "handle"; readonly handle: BabyMediaSourceHandle }
  | {
      readonly type: "buffered";
      readonly video: TimeRange[];
      readonly audio: TimeRange[];
    };

// A mirror of the element's playback state, for the buffering logic.
class PlaybackStateMirror extends EventTarget implements PlaybackState {
  currentTime: number = 0;
  playbackRate: number = 1;
  loop: boolean = false;
}

const playback = new PlaybackStateMirror();
self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as PlaybackStateMessage;
  playback.currentTime = message.currentTime;
  playback.playbackRate = message.playbackRate;
  playback.loop = message.loop;
  playback.dispatchEvent(new Event(message.type));
});

// (The DOM typings don't know we're in a worker.)
const post = postMessage as (
  message: WorkerMessage,
  transfer?: Transferable[]
) => void;

const mediaSource = new BabyMediaSource();
const handle = mediaSource.handle;
post({ type: "handle", handle }, [handle.port]);

const { videoSourceBuffer, audioSourceBuffer } = await startBuffering(
  mediaSource,
  playback
);
const postBuffered = () => {
  post({
    type: "buffered",
    video: videoSourceBuffer.buffered.toArray(),
    audio: audioSourceBuffer.buffered.toArray()
  });
};
videoSourceBuffer.addEventListener("updateend", postBuffered);
audioSourceBuffer.addEventListener("updateend", postBuffered);
