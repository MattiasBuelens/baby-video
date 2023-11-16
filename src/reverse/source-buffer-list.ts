import { ReverseSourceBuffer } from "./source-buffer";

export class ReverseSourceBufferList
  extends Array<ReverseSourceBuffer>
  implements EventTarget, SourceBufferList
{
  readonly #native: SourceBufferList;
  readonly #reverse: readonly ReverseSourceBuffer[];
  readonly #eventBus: EventTarget = new EventTarget();

  onaddsourcebuffer: ((this: SourceBufferList, ev: Event) => any) | null = null;
  onremovesourcebuffer: ((this: SourceBufferList, ev: Event) => any) | null =
    null;

  constructor(
    nativeSourceBufferList: SourceBufferList,
    reverse: ReverseSourceBuffer[]
  ) {
    super();
    this.#native = nativeSourceBufferList;
    this.#reverse = reverse;
    for (const eventType of ["addsourcebuffer", "removesourcebuffer"]) {
      this.#native.addEventListener(eventType, this.#updateAndForward);
    }
    this.#update();
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    this.#eventBus.addEventListener(type, callback, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.#eventBus.dispatchEvent(event);
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    this.#eventBus.removeEventListener(type, callback, options);
  }

  #update() {
    this.length = this.#native.length;
    for (let i = 0; i < this.#native.length; i++) {
      this[i] = this.#reverse.find((sb) => sb.native === this.#native[i])!;
    }
  }

  #updateAndForward = (event: Event) => {
    this.#update();
    this.dispatchEvent(event);
  };
}
