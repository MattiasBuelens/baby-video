import { concatUint8Arrays, queueTask, toUint8Array } from "./util";
import {
  AudioTrackInfo,
  BoxParser,
  createFile,
  Info,
  ISOFile,
  MP4ArrayBuffer,
  MP4BoxStream,
  VideoTrackInfo,
} from "mp4box";
import type { BabyMediaSource } from "./media-source";
import {
  durationChange,
  endOfStream,
  getMediaReadyState,
  updateMediaReadyState,
} from "./media-source";
import {
  AudioTrackBuffer,
  TrackBuffer,
  VideoTrackBuffer,
} from "./track-buffer";
import { MediaReadyState } from "./video-element";

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
    // TODO Steps 3 to 7
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
    console.log(boxType, boxData);
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
      const videoTrackConfigs = info.videoTracks.map(buildVideoConfig);
      for (const audioTrackConfig of audioTrackConfigs) {
        if (!(await AudioDecoder.isConfigSupported(audioTrackConfig))) {
          this.#appendError();
          return;
        }
      }
      for (const videoTrackConfig of videoTrackConfigs) {
        if (!(await VideoDecoder.isConfigSupported(videoTrackConfig))) {
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
      const mediaReadyState = getMediaReadyState(this.#parent);
      // 8.1. If the HTMLMediaElement.readyState attribute is greater than HAVE_CURRENT_DATA,
      //      then set the HTMLMediaElement.readyState attribute to HAVE_METADATA.
      if (mediaReadyState >= MediaReadyState.HAVE_CURRENT_DATA) {
        updateMediaReadyState(this.#parent, MediaReadyState.HAVE_METADATA);
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
        if (mediaReadyState === MediaReadyState.HAVE_NOTHING) {
          updateMediaReadyState(this.#parent, MediaReadyState.HAVE_METADATA);
        }
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

function buildVideoConfig(info: VideoTrackInfo): VideoDecoderConfig {
  return {
    codec: info.codec,
    codedWidth: info.video.width,
    codedHeight: info.video.height,
  };
}
