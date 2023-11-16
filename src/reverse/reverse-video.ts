import { TimeRanges } from "../time-ranges";

export class ReverseVideoElement extends HTMLVideoElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.addEventListener("ended", this.#onEnded);
  }

  disconnectedCallback() {
    this.removeEventListener("ended", this.#onEnded);
  }

  get currentTime(): number {
    return this.duration - super.currentTime;
  }

  set currentTime(time: number) {
    super.currentTime = Math.max(0, this.duration - time);
  }

  fastSeek(time: number) {
    super.fastSeek(Math.max(0, this.duration - time));
  }

  get playbackRate() {
    return -super.playbackRate;
  }

  set playbackRate(value: number) {
    if (value > 0) {
      throw new RangeError("Playback rate must be negative");
    }
    super.playbackRate = -value;
  }

  get buffered() {
    return TimeRanges.from(super.buffered).reverse(this.duration);
  }

  get played() {
    return TimeRanges.from(super.played).reverse(this.duration);
  }

  get seekable() {
    return TimeRanges.from(super.seekable).reverse(this.duration);
  }

  get ended() {
    return false;
  }

  #onEnded(event: Event) {
    event.stopImmediatePropagation();
  }
}

customElements.define("reverse-video", ReverseVideoElement, {
  extends: "video"
});
