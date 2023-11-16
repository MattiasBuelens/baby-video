import { TimeRanges } from "../time-ranges";
import { ReverseMediaSource } from "./media-source";

export class ReverseSourceBuffer extends EventTarget implements SourceBuffer {
  readonly #parent: ReverseMediaSource;
  readonly native: SourceBuffer;

  onabort: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onupdate: ((ev: Event) => void) | null = null;
  onupdatestart: ((ev: Event) => void) | null = null;
  onupdateend: ((ev: Event) => void) | null = null;

  #forwardEvent = this.dispatchEvent.bind(this);

  constructor(nativeSourceBuffer: SourceBuffer, parent: ReverseMediaSource) {
    super();
    this.native = nativeSourceBuffer;
    this.#parent = parent;
    for (const eventType of [
      "abort",
      "error",
      "update",
      "updatestart",
      "updateend"
    ]) {
      this.native.addEventListener(eventType, this.#forwardEvent);
    }
    this.timestampOffset = 0;
  }

  get appendWindowStart(): number {
    return this.#parent.duration - this.native.appendWindowStart;
  }

  set appendWindowStart(value: number) {
    this.native.appendWindowStart = Math.max(0, this.#parent.duration - value);
  }

  get appendWindowEnd(): number {
    return this.#parent.duration - this.native.appendWindowEnd;
  }

  set appendWindowEnd(value: number) {
    this.native.appendWindowEnd = Math.max(0, this.#parent.duration - value);
  }

  get buffered(): TimeRanges {
    return TimeRanges.from(this.native.buffered).reverse(this.#parent.duration);
  }

  get mode(): AppendMode {
    return this.native.mode;
  }

  set mode(mode: AppendMode) {
    this.native.mode = mode;
  }

  get timestampOffset(): number {
    return this.#parent.duration - this.native.timestampOffset;
  }

  set timestampOffset(value: number) {
    this.native.timestampOffset = this.#parent.duration - value;
  }

  get updating(): boolean {
    return this.native.updating;
  }

  abort(): void {
    this.native.abort();
  }

  appendBuffer(data: BufferSource): void {
    // TODO Reverse!
    this.native.appendBuffer(data);
  }

  remove(start: number, end: number): void {
    this.native.remove(
      this.#parent.duration - end,
      this.#parent.duration - start
    );
  }

  changeType(type: string): void {
    this.native.changeType(type);
  }
}
