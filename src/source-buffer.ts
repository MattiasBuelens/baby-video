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
      // 5.2. Run the initialization segment received algorithm.
      this.#isoFile = createFile();
      this.#isoFile.appendBuffer(toMP4ArrayBuffer(boxData, 0));
      this.#isoFilePosition += boxData.byteLength;
    } else if (boxType === "moov") {
      // 5.2. Run the initialization segment received algorithm.
      this.#isoFile!.appendBuffer(
        toMP4ArrayBuffer(boxData, this.#isoFilePosition)
      );
      this.#isoFilePosition += boxData.byteLength;
      this.#mp4Info = this.#isoFile!.getInfo();
      await this.#initializationSegmentReceived(this.#mp4Info);
    } else if (boxType === "moof" || boxType === "mdat") {
      // 6.1. If the [[first initialization segment received flag]] is false
      //      or the [[pending initialization segment for changeType flag]] is true,
      //      then run the append error algorithm and abort this algorithm.
      if (!this.#firstInitializationSegmentReceived) {
        this.#appendError();
        return;
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
    // https://w3c.github.io/media-source/#dfn-initialization-segment-received
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
      // TODO Update track buffers
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

  #codedFrameProcessing(): void {
    // https://w3c.github.io/media-source/#sourcebuffer-coded-frame-processing
    // 1. For each coded frame in the media segment run the following steps:
    for (const trackBuffer of this.#trackBuffers) {
      this.#isoFile!.setExtractionOptions(trackBuffer.trackId, undefined, {});
      // HACK: Do not use decode timestamp from previous sample when parsing a new movie fragment.
      // See https://github.com/gpac/mp4box.js/blob/v0.5.2/src/isofile-sample-processing.js#L422
      this.#isoFile!.getTrackById(trackBuffer.trackId).first_traf_merged =
        false;
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
