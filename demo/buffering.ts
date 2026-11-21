// Buffers the demo stream into a MediaSource, following the playback position.
// Runs wherever the MediaSource lives: on the main thread, or in a worker.
import type { BabyMediaSource, BabySourceBuffer } from "../src/index";
import { TimeRanges } from "../src/time-ranges";
import { waitForEvent } from "../src/util";

export const streamDuration = 634.56;

// What the buffering logic needs to know about the media element.
// On the main thread, that's the element itself. In a worker, it's a mirror
// that the main thread keeps up to date (see worker.ts).
// Fires "timeupdate", "seeking" and "ratechange" events. There's no event for
// changes to loop, but those are picked up at the next "timeupdate".
export interface PlaybackState extends EventTarget {
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly loop: boolean;
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
      endTime: (segmentIndex + 1) * segmentDuration
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

  // The buffered range at the very start of the stream, if any. Like at the
  // end, the range may start slightly after 0 (e.g. with a B-frame reordering
  // delay), so any range starting in the first segment counts.
  function findBufferedRangeAtStart(
    sourceBuffer: BabySourceBuffer,
    segmentForTime: (time: number) => Segment | undefined
  ): readonly [number, number] | undefined {
    const buffered = sourceBuffer.buffered;
    if (
      buffered.length === 0 ||
      buffered.start(0) >= segmentForTime(0)!.endTime
    ) {
      return undefined;
    }
    return [buffered.start(0), buffered.end(0)];
  }

  // Picks the next segment to buffer for a track, or returns undefined if
  // there's enough buffered in the direction of playback.
  // When looping, playback jumps from the end back to the start (or from the
  // start back to the end, when playing backwards), so we keep buffering
  // across that jump: otherwise every loop would stall on a segment fetch.
  function getNextSegment(
    sourceBuffer: BabySourceBuffer,
    segmentForTime: (time: number) => Segment | undefined
  ): Segment | undefined {
    const currentTime = playback.currentTime;
    const currentRange = findBufferedRange(
      sourceBuffer,
      segmentForTime,
      currentTime
    );
    if (!currentRange) {
      // No buffer, need new segment immediately
      return segmentForTime(currentTime);
    }
    // The buffered range may not start or end exactly at a segment boundary
    // (e.g. when frames are offset by a B-frame reordering delay), so snap its
    // edge to the nearest boundary and pick the segment right next to it.
    const segmentDuration = segmentForTime(0)!.endTime;
    const segmentAfter = (time: number) =>
      segmentForTime(
        (Math.round(time / segmentDuration) + 0.5) * segmentDuration
      );
    const segmentBefore = (time: number) =>
      segmentForTime(
        (Math.round(time / segmentDuration) - 0.5) * segmentDuration
      );
    if (playback.playbackRate >= 0) {
      const endRange = findBufferedRange(
        sourceBuffer,
        segmentForTime,
        streamDuration
      );
      const reachesEnd =
        endRange !== undefined && endRange[0] === currentRange[0];
      if (!reachesEnd) {
        // Not enough buffer ahead of current time
        return currentRange[1] - currentTime <= 20
          ? segmentAfter(currentRange[1])
          : undefined;
      }
      if (!playback.loop) {
        // Buffered until the end, nothing more to do.
        return undefined;
      }
      // Continue from the start of the stream.
      const startRange = findBufferedRangeAtStart(sourceBuffer, segmentForTime);
      const ahead = streamDuration - currentTime + (startRange?.[1] ?? 0);
      if (ahead > 20) {
        return undefined;
      }
      return startRange ? segmentAfter(startRange[1]) : segmentForTime(0);
    } else {
      const startRange = findBufferedRangeAtStart(sourceBuffer, segmentForTime);
      const reachesStart =
        startRange !== undefined && startRange[0] === currentRange[0];
      if (!reachesStart) {
        // Not enough buffer behind current time
        return currentTime - currentRange[0] <= 20
          ? segmentBefore(currentRange[0])
          : undefined;
      }
      if (!playback.loop) {
        // Buffered until the start, nothing more to do.
        return undefined;
      }
      // Continue from the end of the stream.
      const endRange = findBufferedRange(
        sourceBuffer,
        segmentForTime,
        streamDuration
      );
      const ahead = currentTime + (endRange ? streamDuration - endRange[0] : 0);
      if (ahead > 20) {
        return undefined;
      }
      return endRange
        ? segmentBefore(endRange[0])
        : segmentForTime(streamDuration);
    }
  }

  // The ranges to keep around the current time. When looping, this wraps
  // around the start and end of the stream, so we don't remove what we just
  // buffered for after the jump.
  function getRetainedRanges(): TimeRanges {
    const forward = playback.playbackRate >= 0;
    const retainStart =
      playback.currentTime - (forward ? backwardBufferSize : forwardBufferSize);
    const retainEnd =
      playback.currentTime + (forward ? forwardBufferSize : backwardBufferSize);
    if (!playback.loop) {
      return new TimeRanges([[retainStart, retainEnd]]);
    }
    return new TimeRanges([
      [retainStart - streamDuration, retainEnd - streamDuration],
      [retainStart, retainEnd],
      [retainStart + streamDuration, retainEnd + streamDuration]
    ]);
  }

  async function trackBufferLoop(
    sourceBuffer: BabySourceBuffer,
    segmentForTime: (time: number) => Segment | undefined,
    signal: AbortSignal
  ) {
    while (true) {
      signal.throwIfAborted();
      // Check buffer health
      let nextSegment: Segment | undefined;
      while (
        (nextSegment = getNextSegment(sourceBuffer, segmentForTime)) ===
        undefined
      ) {
        // Still enough buffer, wait for playback to progress
        await waitForEvent(playback, ["timeupdate", "ratechange"], signal);
      }
      // Remove old buffer before/after current time
      const oldBuffered = sourceBuffer.buffered.subtract(getRetainedRanges());
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
    }
  }

  async function bufferLoop(signal: AbortSignal) {
    await pendingBufferLoop;
    // These only stop when aborted (by a seek or a rate change).
    await Promise.allSettled([
      trackBufferLoop(videoSourceBuffer, getVideoSegmentForTime, signal),
      trackBufferLoop(audioSourceBuffer, getAudioSegmentForTime, signal)
    ]);
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
