// Buffers the demo stream into a MediaSource, following the playback position.
// Runs wherever the MediaSource lives: on the main thread, or in a worker.
import type { BabyMediaSource, BabySourceBuffer } from "../src/index";
import { TimeRanges } from "../src/time-ranges";
import { waitForEvent } from "../src/util";

export const streamDuration = 634.56;

// What the buffering logic needs to know about the media element.
// On the main thread, that's the element itself. In a worker, it's a mirror
// that the main thread keeps up to date (see worker.ts).
// Fires "timeupdate", "seeking" and "ratechange" events.
export interface PlaybackState extends EventTarget {
  readonly currentTime: number;
  readonly playbackRate: number;
}

export interface Buffering {
  readonly videoSourceBuffer: BabySourceBuffer;
  readonly audioSourceBuffer: BabySourceBuffer;
}

export async function startBuffering(
  mediaSource: BabyMediaSource,
  playback: PlaybackState
): Promise<Buffering> {
  if (mediaSource.readyState !== "open") {
    await waitForEvent(mediaSource, "sourceopen");
  }
  mediaSource.duration = streamDuration;
  const videoSourceBuffer = mediaSource.addSourceBuffer(
    'video/mp4; codecs="avc1.640028"'
  );
  const audioSourceBuffer = mediaSource.addSourceBuffer(
    'audio/mp4; codecs="mp4a.40.5"'
  );

  const videoInitSegmentURL =
    "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_0.m4v";
  const audioInitSegmentURL =
    "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_0.m4a";

  AbortSignal.prototype.throwIfAborted ??= function throwIfAborted(
    this: AbortSignal
  ) {
    if (this.aborted) throw this.reason;
  };

  async function appendSegments(
    sourceBuffer: BabySourceBuffer,
    segmentURLs: string[]
  ) {
    for (const segmentURL of segmentURLs) {
      const segmentData = await (await fetch(segmentURL)).arrayBuffer();
      sourceBuffer.appendBuffer(segmentData);
      await waitForEvent(sourceBuffer, "updateend");
    }
  }

  await Promise.all([
    appendSegments(videoSourceBuffer, [videoInitSegmentURL]),
    appendSegments(audioSourceBuffer, [audioInitSegmentURL])
  ]);

  interface Segment {
    url: string;
    startTime: number;
    endTime: number;
    isFirst: boolean;
    isLast: boolean;
  }

  function getSegmentForTime(
    templateUrl: string,
    segmentDuration: number,
    time: number
  ): Segment | undefined {
    const lastSegmentIndex = Math.ceil(streamDuration / segmentDuration) - 1;
    const segmentIndex = Math.max(
      0,
      Math.min(lastSegmentIndex, Math.floor(time / segmentDuration))
    );
    if (segmentIndex < 0) {
      return undefined;
    }
    const url = templateUrl.replace(/%INDEX%/, `${segmentIndex + 1}`);
    return {
      url,
      startTime: segmentIndex * segmentDuration,
      endTime: (segmentIndex + 1) * segmentDuration,
      isFirst: segmentIndex === 0,
      isLast: segmentIndex === lastSegmentIndex
    };
  }

  function getVideoSegmentForTime(time: number): Segment | undefined {
    return getSegmentForTime(
      "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_%INDEX%.m4v",
      120 / 30,
      time
    );
  }

  function getAudioSegmentForTime(time: number): Segment | undefined {
    return getSegmentForTime(
      "https://dash.akamaized.net/akamai/bbb_30fps/bbb_a64k/bbb_a64k_%INDEX%.m4a",
      192512 / 48000,
      time
    );
  }

  // Finds the buffered range containing the given time. Tracks can end at
  // slightly different times, so if the track's last segment is buffered,
  // times past its end (up to the stream duration) count as part of its last range.
  function findBufferedRange(
    sourceBuffer: BabySourceBuffer,
    segmentForTime: (time: number) => Segment | undefined,
    time: number
  ): readonly [number, number] | undefined {
    const buffered = sourceBuffer.buffered;
    const range = buffered.find(time);
    if (range !== undefined || buffered.length === 0) {
      return range;
    }
    const lastRange = [
      buffered.start(buffered.length - 1),
      buffered.end(buffered.length - 1)
    ] as const;
    const lastSegment = segmentForTime(streamDuration)!;
    if (lastRange[1] > lastSegment.startTime && time >= lastRange[1]) {
      return lastRange;
    }
    return undefined;
  }

  // Whether every track has buffered (part of) its last segment.
  function hasBufferedLastSegments(): boolean {
    return (
      findBufferedRange(
        videoSourceBuffer,
        getVideoSegmentForTime,
        streamDuration
      ) !== undefined &&
      findBufferedRange(
        audioSourceBuffer,
        getAudioSegmentForTime,
        streamDuration
      ) !== undefined
    );
  }

  // Signals the end of the stream once the last segments are buffered.
  // This must also happen when buffering backwards, starting from the end:
  // otherwise the buffered ranges end where the *shortest* track ends, and
  // playback can't start at the very end. Appending another segment re-opens the
  // media source, so this must run again after every append. endOfStream() can't
  // be called while another track is still updating, so wait for that first:
  // if we skipped it instead, the media source could stay open forever.
  async function maybeEndOfStream(signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();
      if (mediaSource.readyState !== "open" || !hasBufferedLastSegments()) {
        return;
      }
      const updating = mediaSource.sourceBuffers.find(
        (sourceBuffer) => sourceBuffer.updating
      );
      if (updating === undefined) {
        mediaSource.endOfStream();
        return;
      }
      await waitForEvent(updating, "updateend", signal);
    }
  }

  const forwardBufferSize = 30;
  const backwardBufferSize = 10;

  let pendingBufferLoop: Promise<void> = Promise.resolve();

  async function trackBufferLoop(
    sourceBuffer: BabySourceBuffer,
    segmentForTime: (time: number) => Segment | undefined,
    signal: AbortSignal
  ) {
    while (true) {
      signal.throwIfAborted();
      // Check buffer health
      while (true) {
        const currentRange = findBufferedRange(
          sourceBuffer,
          segmentForTime,
          playback.currentTime
        );
        const forward = playback.playbackRate >= 0;
        if (!currentRange) {
          // No buffer, need new segment immediately
          break;
        }
        if (forward) {
          if (currentRange[1] - playback.currentTime <= 20) {
            // Not enough buffer ahead of current time
            break;
          }
        } else {
          if (playback.currentTime - currentRange[0] <= 20) {
            // Not enough buffer behind current time
            break;
          }
        }
        // Still enough buffer, wait for playback to progress
        await waitForEvent(playback, ["timeupdate", "ratechange"], signal);
      }
      // Find next segment
      const currentRange = findBufferedRange(
        sourceBuffer,
        segmentForTime,
        playback.currentTime
      );
      const forward = playback.playbackRate >= 0;
      // The buffered range may not start or end exactly at a segment boundary
      // (e.g. when frames are offset by a B-frame reordering delay), so snap its
      // edge to the nearest boundary and pick the segment right next to it.
      const segmentDuration = segmentForTime(0)!.endTime;
      const nextTime = currentRange
        ? forward
          ? (Math.round(currentRange[1] / segmentDuration) + 0.5) *
            segmentDuration
          : (Math.round(currentRange[0] / segmentDuration) - 0.5) *
            segmentDuration
        : playback.currentTime;
      const nextSegment = segmentForTime(nextTime)!;
      // Remove old buffer before/after current time
      const retainStart =
        playback.currentTime -
        (forward ? backwardBufferSize : forwardBufferSize);
      const retainEnd =
        playback.currentTime +
        (forward ? forwardBufferSize : backwardBufferSize);
      const oldBuffered = sourceBuffer.buffered.subtract(
        new TimeRanges([[retainStart, retainEnd]])
      );
      for (let i = 0; i < oldBuffered.length; i++) {
        sourceBuffer.remove(oldBuffered.start(i), oldBuffered.end(i));
        await waitForEvent(sourceBuffer, "updateend");
      }
      // Append next segment
      const segmentData = await (
        await fetch(nextSegment.url, { signal })
      ).arrayBuffer();
      sourceBuffer.appendBuffer(segmentData);
      await waitForEvent(sourceBuffer, "updateend");
      await maybeEndOfStream(signal);
      // Check if we're done buffering
      if (forward) {
        if (nextSegment.isLast) {
          return; // Stop buffering until next seek
        }
      } else {
        if (nextSegment.isFirst) {
          return; // Stop buffering until next seek
        }
      }
    }
  }

  async function bufferLoop(signal: AbortSignal) {
    await pendingBufferLoop;
    await Promise.allSettled([
      trackBufferLoop(videoSourceBuffer, getVideoSegmentForTime, signal),
      trackBufferLoop(audioSourceBuffer, getAudioSegmentForTime, signal)
    ]);
    signal.throwIfAborted();
    // All tracks are done buffering until the last segment
    // (or until the first segment, when buffering backwards).
    await maybeEndOfStream(signal);
  }

  let bufferAbortController: AbortController = new AbortController();

  function restartBuffering() {
    bufferAbortController.abort();
    bufferAbortController = new AbortController();
    pendingBufferLoop = bufferLoop(bufferAbortController.signal).catch(
      () => {}
    );
  }

  playback.addEventListener("seeking", restartBuffering);
  playback.addEventListener("ratechange", restartBuffering);
  restartBuffering();

  return { videoSourceBuffer, audioSourceBuffer };
}
