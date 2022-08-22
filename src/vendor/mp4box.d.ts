declare module "mp4box" {
  export class MP4BoxStream {
    constructor(arrayBuffer: ArrayBuffer);

    getPosition(): number;

    seek(position: number): void;
  }

  export interface Box {
    type: string;
    size: number;
    hdr_size: number;
    start: number;
  }

  export const enum BoxParserCode {
    ERR_INVALID_DATA = -1,
    ERR_NOT_ENOUGH_DATA = 0,
    OK = 1,
  }

  export class BoxParser {
    static ERR_INVALID_DATA = BoxParserCode.ERR_INVALID_DATA;
    static ERR_NOT_ENOUGH_DATA = BoxParserCode.ERR_NOT_ENOUGH_DATA;
    static OK = BoxParserCode.OK;

    static parseOneBox(
      stream: MP4BoxStream,
      headerOnly?: boolean
    ): { code: BoxParserCode; box: Box; size: number };
  }
}
