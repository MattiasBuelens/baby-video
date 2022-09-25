import { concatUint8Arrays, queueTask, toUint8Array } from "./util";
import {
  AudioTrackInfo,
  AvcBox,
  Box,
  BoxParser,
  createFile,
  DataStream,
  Info,
  ISOFile,
  MP4ArrayBuffer,
  MP4BoxStream,
  Sample,
  TrackInfo,
  TrakBox,
  VideoTrackInfo,
} from "mp4box";
import type { BabyMediaSource } from "./media-source";
import {
  durationChange,
  endOfStream,
  getMediaElement,
  openIfEnded,
} from "./media-source";
import {
  AudioTrackBuffer,
  TrackBuffer,
  VideoTrackBuffer,
} from "./track-buffer";
import {
  MediaReadyState,
  notifyProgress,
  updateReadyState,
} from "./video-element";
import { setEndTimeOnLastRange, TimeRanges } from "./time-ranges";

export let getVideoTrackBuffer: (
  sourceBuffer: BabySourceBuffer
) => VideoTrackBuffer | undefined;

export class BabySourceBuffer extends EventTarget {
  readonly #parent: BabyMediaSource;
  #inputBuffer: Uint8Array = new Uint8Array(0);
  #updating: boolean = false;
  #firstInitializationSegmentReceived = false;
  #trackBuffers: TrackBuffer[] = [];

  // MP4 specific things
  #initializationData: Uint8Array | undefined = undefined;
  #isoFile: ISOFile | undefined = undefined;
  #isoFilePosition: number = 0;
  #mp4Info: Info | undefined = undefined;

  constructor(parent: BabyMediaSource) {
    super();
    this.#parent = parent;
  }

  get updating(): boolean {
    return this.#updating;
  }

  get buffered(): TimeRanges {
    // https://w3c.github.io/media-source/#dom-sourcebuffer-buffered
    // 1. If this object has been removed from the sourceBuffers attribute of the parent media source
    //    then throw an InvalidStateError exception and abort these steps.
    if (!this.#parent.sourceBuffers.includes(this)) {
      throw new DOMException("Source buffer was removed", "InvalidStateError");
    }
    if (this.#trackBuffers.length === 0) {
      return new TimeRanges([]);
    }
    // 2. Let highest end time be the largest track buffer ranges end time across
    //    all the track buffers managed by this SourceBuffer object.
    const highestEndTime = Math.max(
      ...this.#trackBuffers.map((trackBuffer) => {
        return trackBuffer.trackBufferRanges.length > 0
          ? trackBuffer.trackBufferRanges.end(
              trackBuffer.trackBufferRanges.length - 1
            )
          : 0;
      })
    );
    // 3. Let intersection ranges equal a TimeRanges object containing a single range
    //    from 0 to highest end time.
    let intersectionRanges = new TimeRanges([[0, highestEndTime]]);
    // 4. For each audio and video track buffer managed by this SourceBuffer, run the following steps:
    for (const trackBuffer of this.#trackBuffers) {
      // 4.1. Let track ranges equal the track buffer ranges for the current track buffer.
      let trackRanges = trackBuffer.trackBufferRanges;
      // 4.2. If readyState is "ended", then set the end time on the last range in track ranges to highest end time.
      if (this.#parent.readyState === "ended") {
        trackRanges = setEndTimeOnLastRange(trackRanges, highestEndTime);
      }
      // 4.3. Let new intersection ranges equal the intersection between the intersection ranges and the track ranges.
      // 4.4. Replace the ranges in intersection ranges with the new intersection ranges.
      intersectionRanges = intersectionRanges.intersect(trackRanges);
    }
    return intersectionRanges;
  }

  appendBuffer(data: BufferSource): void {
    // https://w3c.github.io/media-source/#dom-sourcebuffer-appendbuffer
    // 1. Run the prepare append algorithm.
    this.#prepareAppend();
    // 2. Add data to the end of the [[input buffer]].
    this.#inputBuffer = concatUint8Arrays(
      this.#inputBuffer,
      toUint8Array(data)
    );
    // 3. Set the updating attribute to true.
    this.#updating = true;
    // 4. Queue a task to fire an event named updatestart at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("updatestart")));
    // 5. Asynchronously run the buffer append algorithm.
    queueMicrotask(() => this.#bufferAppend());
  }

  remove(start: number, end: number): void {
    // https://w3c.github.io/media-source/#dom-sourcebuffer-remove
    // 1. If this object has been removed from the sourceBuffers attribute of the parent media source
    //    then throw an InvalidStateError exception and abort these steps.
    if (!this.#parent.sourceBuffers.includes(this)) {
      throw new DOMException("Source buffer was removed", "InvalidStateError");
    }
    // 2. If the updating attribute equals true, then throw an InvalidStateError exception and
    //    abort these steps.
    if (this.#updating) {
      throw new DOMException(
        "Source buffer must not be updating",
        "InvalidStateError"
      );
    }
    // 3. If duration equals NaN, then throw a TypeError exception and abort these steps.
    const duration = this.#parent.duration;
    if (Number.isNaN(duration)) {
      throw new TypeError("Duration must not be NaN");
    }
    // 4. If start is negative or greater than duration,
    //    then throw a TypeError exception and abort these steps.
    if (start < 0 || start > duration) {
      throw new TypeError("Start must be positive and less than duration");
    }
    // 5. If end is less than or equal to start or end equals NaN,
    //    then throw a TypeError exception and abort these steps.
    if (end <= start || Number.isNaN(end)) {
      throw new TypeError("End must be greater than start");
    }
    // 6. If the readyState attribute of the parent media source is in the "ended" state
    //    then run the following steps...
    openIfEnded(this.#parent);
    // 7. Run the range removal algorithm with start and end
    //    as the start and end of the removal range.
    this.#rangeRemoval(start, end);
  }

  #prepareAppend(): void {
    // https://w3c.github.io/media-source/#sourcebuffer-prepare-append
    // 1. If the SourceBuffer has been removed from the sourceBuffers attribute of the parent media source
    //    then throw an InvalidStateError exception and abort these steps.
    if (!this.#parent.sourceBuffers.includes(this)) {
      throw new DOMException("Source buffer was removed", "InvalidStateError");
    }
    // 2. If the updating attribute equals true, then throw an InvalidStateError exception and
    //    abort these steps.
    if (this.#updating) {
      throw new DOMException(
        "Source buffer must not be updating",
        "InvalidStateError"
      );
    }
    // TODO Steps 3 to 4
    // 5. If the readyState attribute of the parent media source is in the "ended" state
    //    then run the following steps...
    openIfEnded(this.#parent);
    // TODO Steps 6 to 7
  }

  async #bufferAppend(): Promise<void> {
    // https://w3c.github.io/media-source/#dfn-buffer-append
    // 1. Run the segment parser loop algorithm.
    await this.#segmentParserLoop();
    // 2. If the segment parser loop algorithm in the previous step was aborted,
    //    then abort this algorithm.
    // 3. Set the updating attribute to false.
    this.#updating = false;
    // 4. Queue a task to fire an event named update at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("update")));
    // 5. Queue a task to fire an event named updateend at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("updateend")));
  }

  async #segmentParserLoop(): Promise<void> {
    // https://w3c.github.io/media-source/#sourcebuffer-segment-parser-loop
    const stream = new MP4BoxStream(this.#inputBuffer.buffer);
    try {
      while (true) {
        const parseResult = BoxParser.parseOneBox(stream, true);
        if (parseResult.code === BoxParser.ERR_NOT_ENOUGH_DATA) {
          // 7. Need more data: Return control to the calling algorithm.
          break;
        } else if (parseResult.code === BoxParser.ERR_INVALID_DATA) {
          // 2. If the [[input buffer]] contains bytes that violate the SourceBuffer
          //    byte stream format specification, then run the append error algorithm
          //    and abort this algorithm.
          this.#appendError();
          break;
        } else if (parseResult.code === BoxParser.OK) {
          const boxStart = parseResult.start;
          const boxEnd = parseResult.start + parseResult.size;
          const boxData = this.#inputBuffer.slice(boxStart, boxEnd).buffer;
          await this.#parseBox(parseResult.type, boxData);
          stream.seek(boxEnd);
        }
      }
    } finally {
      this.#inputBuffer = this.#inputBuffer.slice(stream.getPosition());
    }
  }

  async #parseBox(boxType: string, boxData: ArrayBuffer): Promise<void> {
    // https://w3c.github.io/media-source/#sourcebuffer-segment-parser-loop
    if (boxType === "ftyp") {
      this.#initializationData = new Uint8Array(boxData);
      this.#isoFile = undefined;
    } else if (boxType === "moov") {
      // 5.2. Run the initialization segment received algorithm.
      this.#initializationData = concatUint8Arrays(
        this.#initializationData!,
        new Uint8Array(boxData)
      );
      this.#isoFile = createFile();
      this.#isoFilePosition = 0;
      this.#isoFile!.appendBuffer(
        toMP4ArrayBuffer(
          this.#initializationData!.buffer,
          this.#isoFilePosition
        )
      );
      this.#isoFilePosition += boxData.byteLength;
      const newInfo = this.#isoFile!.getInfo();
      await this.#initializationSegmentReceived(newInfo);
      this.#mp4Info = newInfo;
    } else if (boxType === "moof" || boxType === "mdat") {
      // 6.1. If the [[first initialization segment received flag]] is false
      //      or the [[pending initialization segment for changeType flag]] is true,
      //      then run the append error algorithm and abort this algorithm.
      if (!this.#firstInitializationSegmentReceived) {
        this.#appendError();
        return;
      }
      if (boxType === "moof") {
        // Parse each movie fragment separately.
        this.#isoFile = createFile();
        this.#isoFilePosition = 0;
        this.#isoFile.appendBuffer(
          toMP4ArrayBuffer(
            this.#initializationData!.buffer,
            this.#isoFilePosition
          )
        );
        this.#isoFilePosition += this.#initializationData!.byteLength;
      }
      this.#isoFile!.appendBuffer(
        toMP4ArrayBuffer(boxData, this.#isoFilePosition)
      );
      this.#isoFilePosition += boxData.byteLength;
      // 6.2. If the [[input buffer]] contains one or more complete coded frames,
      //      then run the coded frame processing algorithm.
      if (boxType === "mdat") {
        this.#codedFrameProcessing();
      }
    }
  }

  async #initializationSegmentReceived(info: Info): Promise<void> {
    // https://w3c.github.io/media-source/#sourcebuffer-init-segment-received
    // 1. Update the duration attribute if it currently equals NaN
    if (Number.isNaN(this.#parent.duration)) {
      if (info.duration > 0) {
        // If the initialization segment contains a duration:
        // Run the duration change algorithm with new duration set
        // to the duration in the initialization segment.
        durationChange(this.#parent, info.duration);
      } else {
        // Otherwise:
        // Run the duration change algorithm with new duration set to positive Infinity.
        durationChange(this.#parent, +Infinity);
      }
    }
    // 2. If the initialization segment has no audio, video, or text tracks,
    //    then run the append error algorithm and abort these steps.
    if (info.audioTracks.length === 0 && info.videoTracks.length === 0) {
      this.#appendError();
      return;
    }
    // 3. If the [[first initialization segment received flag]] is true,
    //    then run the following steps:
    if (this.#firstInitializationSegmentReceived) {
      // 3.1. Verify the following properties. If any of the checks fail
      //      then run the append error algorithm and abort these steps.
      const oldInfo = this.#mp4Info!;
      // * The number of audio, video, and text tracks match what was
      //   in the first initialization segment.
      if (
        info.audioTracks.length !== oldInfo.audioTracks.length ||
        info.videoTracks.length !== oldInfo.videoTracks.length
      ) {
        this.#appendError();
        return;
      }
      // * If more than one track for a single type are present (e.g., 2 audio tracks),
      //   then the Track IDs match the ones in the first initialization segment.
      if (
        (info.audioTracks.length > 1 &&
          !hasMatchingTrackIds(info.audioTracks, oldInfo.audioTracks)) ||
        (info.videoTracks.length > 1 &&
          !hasMatchingTrackIds(info.videoTracks, oldInfo.videoTracks))
      ) {
        this.#appendError();
        return;
      }
      // * The codecs for each track are supported by the user agent.
      const audioTrackConfigs = info.audioTracks.map(buildAudioConfig);
      const videoTrackConfigs = info.videoTracks.map((trackInfo) =>
        buildVideoConfig(trackInfo, this.#isoFile!.getTrackById(trackInfo.id))
      );
      for (const audioTrackConfig of audioTrackConfigs) {
        const support = await AudioDecoder.isConfigSupported(audioTrackConfig);
        if (!support.supported) {
          this.#appendError();
          return;
        }
      }
      for (const videoTrackConfig of videoTrackConfigs) {
        const support = await VideoDecoder.isConfigSupported(videoTrackConfig);
        if (!support.supported) {
          this.#appendError();
          return;
        }
      }
      // 3.2. Add the appropriate track descriptions from this initialization segment to each of the track buffers.
      for (let i = 0; i < info.audioTracks.length; i++) {
        const audioTrackInfo = info.audioTracks[i];
        const audioTrackConfig = audioTrackConfigs[i];
        const trackBuffer = this.#getMatchingTrackBuffer(audioTrackInfo)!;
        trackBuffer.reconfigure(audioTrackConfig);
      }
      for (let i = 0; i < info.videoTracks.length; i++) {
        const videoTrackInfo = info.videoTracks[i];
        const videoTrackConfig = videoTrackConfigs[i];
        const trackBuffer = this.#getMatchingTrackBuffer(videoTrackInfo)!;
        trackBuffer.reconfigure(videoTrackConfig);
      }
      // 3.3. Set the need random access point flag on all track buffers to true.
      for (const trackBuffer of this.#trackBuffers) {
        trackBuffer.needRandomAccessPoint = true;
      }
    }
    // 4. Let active track flag equal false.
    let activeTrack = false;
    // 5. If the [[first initialization segment received flag]] is false,
    //    then run the following steps:
    if (!this.#firstInitializationSegmentReceived) {
      // 5.1. If the initialization segment contains tracks with codecs
      //      the user agent does not support, then run the append error
      //      algorithm and abort these steps.
      const audioTrackConfigs = info.audioTracks.map(buildAudioConfig);
      const videoTrackConfigs = info.videoTracks.map((trackInfo) =>
        buildVideoConfig(trackInfo, this.#isoFile!.getTrackById(trackInfo.id))
      );
      for (const audioTrackConfig of audioTrackConfigs) {
        const support = await AudioDecoder.isConfigSupported(audioTrackConfig);
        if (!support.supported) {
          this.#appendError();
          return;
        }
      }
      for (const videoTrackConfig of videoTrackConfigs) {
        const support = await VideoDecoder.isConfigSupported(videoTrackConfig);
        if (!support.supported) {
          this.#appendError();
          return;
        }
      }
      // 5.2. For each audio track in the initialization segment,
      //      run following steps:
      for (let i = 0; i < info.audioTracks.length; i++) {
        const audioTrackInfo = info.audioTracks[i];
        const audioTrackConfig = audioTrackConfigs[i];
        // 5.2.6.7.2. Set active track flag to true.
        activeTrack = true;
        // 5.2.7. Create a new track buffer to store coded frames for this track.
        // 5.2.8. Add the track description for this track to the track buffer.
        const trackBuffer = new AudioTrackBuffer(
          audioTrackInfo.id,
          audioTrackConfig
        );
        this.#trackBuffers.push(trackBuffer);
      }
      // 5.3. For each video track in the initialization segment,
      //      run following steps:
      for (let i = 0; i < info.videoTracks.length; i++) {
        const videoTrackInfo = info.videoTracks[i];
        const videoTrackConfig = videoTrackConfigs[i];
        // 5.3.6.7.2. Set active track flag to true.
        activeTrack = true;
        // 5.3.7. Create a new track buffer to store coded frames for this track.
        // 5.3.8. Add the track description for this track to the track buffer.
        const trackBuffer = new VideoTrackBuffer(
          videoTrackInfo.id,
          videoTrackConfig
        );
        this.#trackBuffers.push(trackBuffer);
      }
      // 5.5. If active track flag equals true, then run the following steps:
      if (activeTrack) {
        // 5.5.1. Add this SourceBuffer to activeSourceBuffers.
        // 5.5.2. Queue a task to fire an event named addsourcebuffer at activeSourceBuffers
        // TODO
      }
      // 5.6. Set [[first initialization segment received flag]] to true.
      this.#firstInitializationSegmentReceived = true;
    }
    // 7. If the active track flag equals true, then run the following steps:
    if (activeTrack) {
      const mediaElement = getMediaElement(this.#parent)!;
      // 8.1. If the HTMLMediaElement.readyState attribute is greater than HAVE_CURRENT_DATA,
      //      then set the HTMLMediaElement.readyState attribute to HAVE_METADATA.
      if (mediaElement.readyState >= MediaReadyState.HAVE_CURRENT_DATA) {
        updateReadyState(mediaElement, MediaReadyState.HAVE_METADATA);
      }
      // 9. If each object in sourceBuffers of the parent media source
      //    has [[first initialization segment received flag]] equal to true,
      if (
        this.#parent.sourceBuffers.every(
          (sourceBuffer) => sourceBuffer.#firstInitializationSegmentReceived
        )
      ) {
        // 9.1. If the HTMLMediaElement.readyState attribute is HAVE_NOTHING,
        //      then set the HTMLMediaElement.readyState attribute to HAVE_METADATA.
        if (mediaElement.readyState === MediaReadyState.HAVE_NOTHING) {
          updateReadyState(mediaElement, MediaReadyState.HAVE_METADATA);
        }
      }
    }
  }

  #getMatchingTrackBuffer(track: AudioTrackInfo): AudioTrackBuffer | undefined;
  #getMatchingTrackBuffer(track: VideoTrackInfo): VideoTrackBuffer | undefined;
  #getMatchingTrackBuffer(track: TrackInfo): TrackBuffer | undefined {
    return (
      this.#trackBuffers.find((buffer) => buffer.trackId === track.id) ??
      this.#trackBuffers.find((buffer) => buffer.type === track.type)
    );
  }

  #codedFrameProcessing(): void {
    // https://w3c.github.io/media-source/#sourcebuffer-coded-frame-processing
    // 1. For each coded frame in the media segment run the following steps:
    for (const trackBuffer of this.#trackBuffers) {
      this.#isoFile!.setExtractionOptions(trackBuffer.trackId, undefined, {});
    }
    this.#isoFile!.onSamples = (trackId, _user, samples) =>
      this.#processSamples(trackId, samples);
    this.#isoFile!.start();
    this.#isoFile!.flush();
    this.#isoFile!.stop();
    // 2. If the HTMLMediaElement.readyState attribute is HAVE_METADATA and the new coded frames
    //    cause HTMLMediaElement.buffered to have a TimeRanges for the current playback position,
    //    then set the HTMLMediaElement.readyState attribute to HAVE_CURRENT_DATA.
    const mediaElement = getMediaElement(this.#parent)!;
    const buffered = mediaElement.buffered;
    const currentTime = mediaElement.currentTime;
    if (
      mediaElement.readyState === MediaReadyState.HAVE_METADATA &&
      buffered.contains(currentTime)
    ) {
      updateReadyState(mediaElement, MediaReadyState.HAVE_CURRENT_DATA);
    }
    // 3. If the HTMLMediaElement.readyState attribute is HAVE_CURRENT_DATA and the new coded frames
    //    cause HTMLMediaElement.buffered to have a TimeRanges that includes the current playback position
    //    and some time beyond the current playback position, then set the HTMLMediaElement.readyState
    //    attribute to HAVE_FUTURE_DATA.
    if (
      mediaElement.readyState === MediaReadyState.HAVE_CURRENT_DATA &&
      buffered.containsRange(currentTime, currentTime + 0.1)
    ) {
      updateReadyState(mediaElement, MediaReadyState.HAVE_FUTURE_DATA);
    }
    // 4. If the HTMLMediaElement.readyState attribute is HAVE_FUTURE_DATA and the new coded frames
    //    cause HTMLMediaElement.buffered to have a TimeRanges that includes the current playback position
    //    and enough data to ensure uninterrupted playback, then set the HTMLMediaElement.readyState
    //    attribute to HAVE_ENOUGH_DATA.
    // TODO
    // 5. If the media segment contains data beyond the current duration, then run the duration change
    //    algorithm with new duration set to the maximum of the current duration and the [[group end timestamp]].
    // TODO
    notifyProgress(mediaElement);
  }

  #processSamples(trackId: number, samples: Sample[]): void {
    // https://w3c.github.io/media-source/#sourcebuffer-coded-frame-processing
    const trackBuffer = this.#trackBuffers.find(
      (trackBuffer) => trackBuffer.trackId === trackId
    )!;
    // 1. For each coded frame in the media segment run the following steps:
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      // 1.2. Let decode timestamp be a double precision floating point representation
      //      of the coded frame's decode timestamp in seconds.
      const dts = sample.dts / sample.timescale;
      // 4. If timestampOffset is not 0, then run the following steps:
      // TODO timestampOffset
      // 5. Let track buffer equal the track buffer that the coded frame will be added to.
      // 6. If last decode timestamp for track buffer is set and decode timestamp
      //    is less than last decode timestamp:
      //     OR
      //    If last decode timestamp for track buffer is set and the difference between
      //    decode timestamp and last decode timestamp is greater than 2 times last frame duration:
      if (
        trackBuffer.lastDecodeTimestamp !== undefined &&
        (dts < trackBuffer.lastDecodeTimestamp ||
          dts - trackBuffer.lastDecodeTimestamp >
            2 * trackBuffer.lastFrameDuration!)
      ) {
        // 6.2. Unset the last decode timestamp on all track buffers.
        // 6.3. Unset the last frame duration on all track buffers.
        // 6.4. Unset the highest end timestamp on all track buffers.
        // 6.5. Set the need random access point flag on all track buffers to true.
        for (const trackBuffer of this.#trackBuffers) {
          trackBuffer.requireRandomAccessPoint();
        }
        // 6.6. Jump to the Loop Top step above to restart processing of the current coded frame.
        i--;
        continue;
      }
      // TODO 8 and 9 appendWindowStart and appendWindowEnd
      // 10. If the need random access point flag on track buffer equals true,
      //     then run the following steps:
      if (trackBuffer.needRandomAccessPoint) {
        // 10.1. If the coded frame is not a random access point, then drop the coded frame
        //       and jump to the top of the loop to start processing the next coded frame.
        if (!sample.is_sync) {
          continue;
        }
        // 10.2. Set the need random access point flag on track buffer to false.
        trackBuffer.needRandomAccessPoint = false;
      }
      // TODO 11 to 15 Remove overlapping frames
      // Steps 16 to 19
      trackBuffer.addSample(sample);
    }
    if (samples.length > 0) {
      this.#isoFile!.releaseUsedSamples(
        trackId,
        samples[samples.length - 1].number
      );
    }
  }

  #rangeRemoval(start: number, end: number): void {
    // https://w3c.github.io/media-source/#dfn-range-removal
    // 3. Set the updating attribute to true.
    this.#updating = true;
    // 4. Queue a task to fire an event named updatestart at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("updatestart")));
    // 5. Return control to the caller and run the rest of the steps asynchronously.
    queueMicrotask(() => {
      // 6. Run the coded frame removal algorithm with start and end as the start and end of the removal range.
      this.#codedFrameRemoval(start, end);
      // 7. Set the updating attribute to false.
      this.#updating = false;
      // 8. Queue a task to fire an event named update at this SourceBuffer object.
      queueTask(() => this.dispatchEvent(new Event("update")));
      // 9. Queue a task to fire an event named updateend at this SourceBuffer object.
      queueTask(() => this.dispatchEvent(new Event("updateend")));
    });
  }

  #codedFrameRemoval(start: number, end: number): void {
    // https://w3c.github.io/media-source/#dfn-coded-frame-removal
    const startInMicros = 1e6 * start;
    const endInMicros = 1e6 * end;
    const mediaElement = getMediaElement(this.#parent)!;
    const currentTimeInMicros = 1e6 * mediaElement.currentTime;
    // 3. For each track buffer in this SourceBuffer, run the following steps:
    for (const trackBuffer of this.#trackBuffers) {
      // 3.1. Let remove end timestamp be the current value of duration.
      let removeEndTimestamp = 1e6 * this.#parent.duration;
      // 3.2. If this track buffer has a random access point timestamp
      //      that is greater than or equal to end, then update remove end timestamp
      //      to that random access point timestamp.
      removeEndTimestamp =
        trackBuffer.getRandomAccessPointAtOrAfter(endInMicros) ??
        removeEndTimestamp;
      // 3.3. Remove all media data, from this track buffer, that contain starting timestamps
      //      greater than or equal to start and less than the remove end timestamp.
      trackBuffer.removeSamples(startInMicros, removeEndTimestamp);
      // 3.3.1. For each removed frame, if the frame has a decode timestamp equal to
      //        the last decode timestamp for the frame's track, run the following steps:
      // TODO
      // 3.3.2. Unset the last decode timestamp on all track buffers.
      // 3.3.3. Unset the last frame duration on all track buffers.
      // 3.3.4. Unset the highest end timestamp on all track buffers.
      // 3.3.5. Set the need random access point flag on all track buffers to true.
      trackBuffer.requireRandomAccessPoint();
      // 3.4. Remove all possible decoding dependencies on the coded frames removed
      //      in the previous step by removing all coded frames from this track buffer
      //      between those frames removed in the previous step and the next random
      //      access point after those removed frames.
      // (Already handled by removeSamples.)
      // 3.5. If this object is in activeSourceBuffers, the current playback position
      //      is greater than or equal to start and less than the remove end timestamp,
      //      and HTMLMediaElement.readyState is greater than HAVE_METADATA,
      //      then set the HTMLMediaElement.readyState attribute to HAVE_METADATA and stall playback.
      if (
        currentTimeInMicros >= start &&
        currentTimeInMicros < removeEndTimestamp &&
        mediaElement.readyState > MediaReadyState.HAVE_METADATA
      ) {
        updateReadyState(mediaElement, MediaReadyState.HAVE_METADATA);
      }
    }
  }

  #resetParserState() {
    // https://w3c.github.io/media-source/#sourcebuffer-reset-parser-state
    // TODO Steps 1 to 6
    // 7. Remove all bytes from the [[input buffer]].
    this.#inputBuffer = new Uint8Array(0);
    // 8. Set [[append state]] to WAITING_FOR_SEGMENT.
    //    (Ignored.)
  }

  #appendError() {
    // https://w3c.github.io/media-source/#dfn-append-error
    // 1. Run the reset parser state algorithm.
    this.#resetParserState();
    // 2. Set the updating attribute to false.
    this.#updating = false;
    // 3. Queue a task to fire an event named error at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("error")));
    // 4. Queue a task to fire an event named updateend at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("updateend")));
    // 5. Run the end of stream algorithm with the error parameter set to "decode".
    endOfStream(this.#parent, "decode");
  }

  #getVideoTrackBuffer(): VideoTrackBuffer | undefined {
    return this.#trackBuffers.find(
      (trackBuffer): trackBuffer is VideoTrackBuffer =>
        trackBuffer instanceof VideoTrackBuffer
    );
  }

  static {
    getVideoTrackBuffer = (sourceBuffer) => sourceBuffer.#getVideoTrackBuffer();
  }
}

function toMP4ArrayBuffer(ab: ArrayBuffer, fileStart: number): MP4ArrayBuffer {
  return Object.assign(ab, { fileStart });
}

function buildAudioConfig(info: AudioTrackInfo): AudioDecoderConfig {
  return {
    codec: info.codec,
    numberOfChannels: info.audio.channel_count,
    sampleRate: info.audio.sample_rate,
  };
}

function buildVideoConfig(
  info: VideoTrackInfo,
  trak: TrakBox
): VideoDecoderConfig {
  return {
    codec: info.codec,
    codedWidth: info.video.width,
    codedHeight: info.video.height,
    description: createAvcDecoderConfigurationRecord(trak),
  };
}

function isAvcEntry(entry: Box): entry is AvcBox {
  return (entry as AvcBox).avcC !== undefined;
}

function createAvcDecoderConfigurationRecord(
  trak: TrakBox
): Uint8Array | undefined {
  // https://www.w3.org/TR/webcodecs-avc-codec-registration/#videodecoderconfig-description
  const avcC = trak.mdia.minf.stbl.stsd.entries.find(isAvcEntry)?.avcC;
  if (!avcC) {
    return undefined;
  }
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  avcC.write(stream);
  return new Uint8Array(stream.buffer, 8); // remove the box header
}

function hasMatchingTrackIds(
  newTracks: readonly TrackInfo[],
  oldTracks: readonly TrackInfo[]
): boolean {
  return newTracks.every((newTrack) =>
    oldTracks.some((oldTrack) => newTrack.id === oldTrack.id)
  );
}
