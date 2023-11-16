import { ReverseSourceBuffer } from "./source-buffer";
import { ReverseSourceBufferList } from "./source-buffer-list";

export class ReverseMediaSource extends EventTarget implements MediaSource {
  readonly native: MediaSource = new MediaSource();
  readonly reverseSourceBuffers: ReverseSourceBuffer[] = [];

  readonly activeSourceBuffers: SourceBufferList = new ReverseSourceBufferList(
    this.native.activeSourceBuffers,
    this.reverseSourceBuffers
  );
  readonly sourceBuffers: SourceBufferList = new ReverseSourceBufferList(
    this.native.sourceBuffers,
    this.reverseSourceBuffers
  );

  onsourceclose: ((this: MediaSource, ev: Event) => any) | null = null;
  onsourceended: ((this: MediaSource, ev: Event) => any) | null = null;
  onsourceopen: ((this: MediaSource, ev: Event) => any) | null = null;

  get duration(): number {
    return this.native.duration;
  }

  get readyState(): ReadyState {
    return this.native.readyState;
  }

  addSourceBuffer(type: string): ReverseSourceBuffer {
    const reverse = new ReverseSourceBuffer(
      this.native.addSourceBuffer(type),
      this
    );
    this.reverseSourceBuffers.push(reverse);
    return reverse;
  }

  removeSourceBuffer(sourceBuffer: ReverseSourceBuffer): void {
    const index = this.reverseSourceBuffers.findIndex(
      (sb) => sb === sourceBuffer
    );
    if (index >= 0) {
      this.native.removeSourceBuffer(this.reverseSourceBuffers[index].native);
      this.reverseSourceBuffers.splice(index, 1);
    }
  }

  endOfStream(error?: EndOfStreamError): void {
    this.native.endOfStream(error);
  }

  setLiveSeekableRange(start: number, end: number): void {
    this.native.setLiveSeekableRange(
      this.duration - end,
      this.duration - start
    );
  }

  clearLiveSeekableRange(): void {
    this.native.clearLiveSeekableRange();
  }

  static isTypeSupported(type: string): boolean {
    return MediaSource.isTypeSupported(type);
  }
}
