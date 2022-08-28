import stylesheet from "./style.css";
import {
  attachToMediaElement,
  BabyMediaSource,
  detachFromMediaElement,
  getBuffered,
} from "./media-source";
import { queueTask } from "./util";
import { TimeRanges } from "./time-ranges";

const template = document.createElement("template");
template.innerHTML = `<style>${stylesheet}</style>`;

export enum MediaReadyState {
  HAVE_NOTHING,
  HAVE_METADATA,
  HAVE_CURRENT_DATA,
  HAVE_FUTURE_DATA,
  HAVE_ENOUGH_DATA,
}

export let updateDuration: (videoElement: BabyVideoElement) => void;
export let updateReadyState: (
  videoElement: BabyVideoElement,
  newReadyState: MediaReadyState
) => void;

export class BabyVideoElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement;
  readonly #canvasContext: CanvasRenderingContext2D;

  #currentTime: number = 0;
  #readyState: MediaReadyState = 0;
  #srcObject: BabyMediaSource | undefined;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(template.content.cloneNode(true));

    this.#canvas = document.createElement("canvas");
    this.#canvas.width = 1920;
    this.#canvas.height = 1080;
    this.#canvas.style.width = "100%";
    this.#canvas.style.aspectRatio = "16 / 9";
    shadow.appendChild(this.#canvas);

    this.#canvasContext = this.#canvas.getContext("2d")!;
    this.#canvasContext.fillStyle = "black";
    this.#canvasContext.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
  }

  connectedCallback(): void {
    // Consider checking for properties that may have been set
    // before the element upgraded.
    // https://web.dev/custom-elements-best-practices/
    this.#upgradeProperty("srcObject");
    this.#upgradeProperty("currentTime");
  }

  #upgradeProperty(prop: keyof this) {
    if (this.hasOwnProperty(prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  get buffered(): TimeRanges {
    return this.#srcObject ? getBuffered(this.#srcObject) : new TimeRanges([]);
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
  }

  get duration(): number {
    if (!this.#srcObject) {
      return NaN;
    }
    return this.#srcObject.duration;
  }

  get readyState(): MediaReadyState {
    return this.#readyState;
  }

  get srcObject(): BabyMediaSource | undefined {
    return this.#srcObject;
  }

  set srcObject(srcObject: BabyMediaSource | undefined) {
    if (this.#srcObject) {
      detachFromMediaElement(this.#srcObject);
    }
    this.#srcObject = srcObject;
    if (srcObject) {
      attachToMediaElement(srcObject, this);
    }
  }

  static {
    updateDuration = (videoElement: BabyVideoElement) => {
      queueTask(() => videoElement.dispatchEvent(new Event("durationchange")));
      const newDuration = videoElement.duration;
      if (videoElement.currentTime > newDuration) {
        videoElement.currentTime = newDuration;
      }
    };
    updateReadyState = (
      videoElement: BabyVideoElement,
      newReadyState: MediaReadyState
    ) => {
      videoElement.#readyState = newReadyState;
      // TODO https://html.spec.whatwg.org/multipage/media.html#ready-states
    };
  }
}

customElements.define("baby-video", BabyVideoElement);
