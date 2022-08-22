import { concatUint8Arrays, queueTask, toUint8Array } from "./util";
import { BoxParser, MP4BoxStream } from "mp4box";
import type { BabyMediaSource } from "./media-source";

export class BabySourceBuffer extends EventTarget {
  readonly #parent: BabyMediaSource;
  #inputBuffer: Uint8Array = new Uint8Array(0);
  #updating: boolean = false;
  #appendState: AppendState = AppendState.WAITING_FOR_SEGMENT;

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

  #bufferAppend(): void {
    // https://w3c.github.io/media-source/#dfn-buffer-append
    // 1. Run the segment parser loop algorithm.
    this.#segmentParserLoop();
    // 2. If the segment parser loop algorithm in the previous step was aborted,
    //    then abort this algorithm.
    // 3. Set the updating attribute to false.
    this.#updating = false;
    // 4. Queue a task to fire an event named update at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("update")));
    // 5. Queue a task to fire an event named updateend at this SourceBuffer object.
    queueTask(() => this.dispatchEvent(new Event("updateend")));
  }

  #segmentParserLoop(): void {
    const stream = new MP4BoxStream(this.#inputBuffer.buffer);
    let lastBoxStart = stream.getPosition();
    while (true) {
      const parseResult = BoxParser.parseOneBox(stream, false);
      if (parseResult.code === BoxParser.ERR_NOT_ENOUGH_DATA) {
        stream.seek(lastBoxStart);
        break;
      } else if (parseResult.code === BoxParser.ERR_INVALID_DATA) {
        // TODO Handle parse errors
        console.error(parseResult);
      } else if (parseResult.code === BoxParser.OK) {
        lastBoxStart = stream.getPosition();
        console.log(parseResult.box, lastBoxStart);
      }
    }
    this.#inputBuffer = this.#inputBuffer.slice(stream.getPosition());
  }
}

// https://w3c.github.io/media-source/#dfn-append-state
const enum AppendState {
  WAITING_FOR_SEGMENT,
  PARSING_INIT_SEGMENT,
  PARSING_MEDIA_SEGMENT,
}
