import stylesheet from "./style.css";
import {
  attachToMediaElement,
  BabyMediaSource,
  detachFromMediaElement,
  getActiveVideoTrackBuffer,
  getBuffered,
} from "./media-source";
import { queueTask } from "./util";
import { TimeRanges } from "./time-ranges";
import { Sample } from "mp4box";

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

  readonly #videoDecoder: VideoDecoder;
  #lastDecodedVideoSample: Sample | undefined;
  #pendingVideoFrame: VideoFrame | undefined;

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

    this.#videoDecoder = new VideoDecoder({
      output: (frame) => this.#onVideoFrame(frame),
      error: (error) => console.error("WTF", error),
    });
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
    this.#render();
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

  #render(): void {
    const mediaSource = this.#srcObject;
    if (!mediaSource) {
      return;
    }
    const videoTrackBuffer = getActiveVideoTrackBuffer(mediaSource);
    if (!videoTrackBuffer) {
      return;
    }
    if (this.#videoDecoder.state === "unconfigured") {
      this.#videoDecoder.configure(videoTrackBuffer.codecConfig);
    }
    const sample = videoTrackBuffer.findSampleForTime(this.currentTime);
    if (sample && this.#lastDecodedVideoSample !== sample) {
      this.#videoDecoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (1e6 * sample.cts) / sample.timescale,
          duration: (1e6 * sample.duration) / sample.timescale,
          data: sample.data,
        })
      );
      this.#lastDecodedVideoSample = sample;
    }
  }

  #onVideoFrame(frame: VideoFrame): void {
    if (this.#pendingVideoFrame) {
      this.#pendingVideoFrame.close();
    } else {
      requestAnimationFrame(() => this.#renderVideoFrame());
    }
    this.#pendingVideoFrame = frame;
  }

  #renderVideoFrame(): void {
    const frame = this.#pendingVideoFrame;
    if (!frame) {
      return;
    }
    this.#canvas.width = frame.displayWidth;
    this.#canvas.height = frame.displayHeight;
    this.#canvasContext.drawImage(
      frame,
      0,
      0,
      frame.displayWidth,
      frame.displayHeight
    );
    frame.close();
    this.#pendingVideoFrame = undefined;
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
      videoElement.#render();
    };
  }
}

customElements.define("baby-video", BabyVideoElement);
