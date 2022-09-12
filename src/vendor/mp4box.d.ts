declare module "mp4box" {
  export class MP4BoxStream {
    constructor(arrayBuffer: ArrayBuffer);

    getPosition(): number;

    seek(position: number): void;
  }

  export class DataStream {
    static BIG_ENDIAN = false;
    static LITTLE_ENDIAN = true;

    constructor(
      arrayBuffer: ArrayBuffer | undefined,
      byteOffset: number,
      endianness: boolean
    );

    readonly buffer: ArrayBuffer;
  }

  export interface Box {
    type: string;
    size: number;
    hdr_size: number;
    start: number;

    write(stream: DataStream): void;
  }

  export enum BoxParser {
    ERR_INVALID_DATA = -1,
    ERR_NOT_ENOUGH_DATA = 0,
    OK = 1,
  }

  export interface BoxResult {
    code: BoxParser.OK;
    box: Box;
    size: number;
  }

  export interface HeaderOnlyResult {
    code: BoxParser.OK;
    type: string;
    size: number;
    hdr_size: number;
    start: number;
  }

  export interface InvalidDataResult {
    code: BoxParser.ERR_INVALID_DATA;
  }

  export interface NotEnoughDataResult {
    code: BoxParser.ERR_NOT_ENOUGH_DATA;
    type?: string;
    size?: number;
    hdr_size?: number;
    start?: number;
  }

  export namespace BoxParser {
    export function parseOneBox(
      stream: MP4BoxStream,
      headerOnly: true
    ): HeaderOnlyResult | InvalidDataResult | NotEnoughDataResult;

    export function parseOneBox(
      stream: MP4BoxStream,
      headerOnly?: false
    ): BoxResult | InvalidDataResult | NotEnoughDataResult;
  }

  export function createFile(): ISOFile;

  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface ISOFile {
    appendBuffer(ab: MP4ArrayBuffer): void;

    getInfo(): Info;

    getTrackById(trackId: number): TrakBox;

    setExtractionOptions(
      trackId: number,
      user: any,
      options: ExtractionOptions
    );

    start(): void;

    stop(): void;

    flush(): void;

    onSamples?: (trackId: number, user: any, samples: Sample[]) => void;

    releaseUsedSamples(trackId: number, sampleNum: number): void;
  }

  export interface Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: TrackInfo[];
    audioTracks: AudioTrackInfo[];
    videoTracks: VideoTrackInfo[];
  }

  export interface TrackInfo {
    id: number;
    name: string;
    created: Date;
    modified: Date;
    movie_duration: number;
    layer: number;
    alternate_group: number;
    volume: number;
    track_width: number;
    track_height: number;
    timescale: number;
    duration: number;
    bitrate: number;
    codec: string;
    language: "und";
    nb_samples: number;
  }

  export interface AudioTrackInfo extends TrackInfo {
    type: "audio";
    audio: {
      sample_rate: number;
      channel_count: number;
      sample_size: number;
    };
  }

  export interface VideoTrackInfo extends TrackInfo {
    type: "video";
    video: {
      width: number;
      height: number;
    };
  }

  export interface TrakBox extends Box {
    type: "trak";
    mdia: MdiaBox;
  }

  export interface MdiaBox extends Box {
    type: "mdia";
    minf: MinfBox;
  }

  export interface MinfBox extends Box {
    type: "minf";
    stbl: StblBox;
  }

  export interface StblBox extends Box {
    type: "stbl";
    stsd: StsdBox;
  }

  export interface StsdBox extends Box {
    type: "stsd";
    entries: Box[];
  }

  export interface AvcBox extends Box {
    type: "avc1";
    avcC: AvccBox;
  }

  export interface AvccBox extends Box {
    type: "avcC";
  }

  export interface ExtractionOptions {
    nbSamples?: number;
  }

  export interface Sample {
    number: number;
    track_id: number;
    timescale: number;
    description: Box;
    size: number;
    data: Uint8Array;
    duration: number;
    dts: number;
    cts: number;
    is_sync: boolean;
    is_leading: number;
    is_depended_on: number;
    has_redundancy: number;
    degradation_priority: number;
    offset: number;
  }
}
