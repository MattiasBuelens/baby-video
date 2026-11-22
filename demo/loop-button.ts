import { constants, MediaChromeButton } from "media-chrome";

const { MediaUIAttributes, MediaUIEvents } = constants;

// Two arrows going round, like 🔁.
const loopIconOn = `<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7Zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4Z"/>
</svg>`;
// The same, struck through.
const loopIconOff = `<svg aria-hidden="true" viewBox="0 0 24 24">
  <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7Zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4Z"/>
  <path d="M3.7 2.3 21.7 20.3 20.3 21.7 2.3 3.7Z"/>
</svg>`;

// A loop toggle for the control bar. media-chrome has <media-loop-button>,
// but that one is meant for a settings menu: a "Loop" label and a check mark.
// This one shows an icon, like the other buttons in the control bar.
class DemoLoopButton extends MediaChromeButton {
  static get observedAttributes(): string[] {
    return [...super.observedAttributes, MediaUIAttributes.MEDIA_LOOP];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("role", "switch");
    this.#update();
  }

  attributeChangedCallback(
    attrName: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    super.attributeChangedCallback(attrName, oldValue, newValue);
    if (attrName === MediaUIAttributes.MEDIA_LOOP) {
      this.#update();
    }
  }

  // <media-controller> sets this when the media's loop state changes.
  get mediaLoop(): boolean {
    return this.hasAttribute(MediaUIAttributes.MEDIA_LOOP);
  }

  set mediaLoop(value: boolean) {
    this.toggleAttribute(MediaUIAttributes.MEDIA_LOOP, value);
  }

  handleClick(): void {
    this.dispatchEvent(
      new CustomEvent(MediaUIEvents.MEDIA_LOOP_REQUEST, {
        composed: true,
        bubbles: true,
        detail: !this.mediaLoop
      })
    );
  }

  #update(): void {
    this.setAttribute("aria-checked", String(this.mediaLoop));
    this.setAttribute("aria-label", "loop");
  }
}

DemoLoopButton.getSlotTemplateHTML = () => `
  <style>
    :host([aria-checked="true"]) slot[name=off],
    :host(:not([aria-checked="true"])) slot[name=on] {
      display: none !important;
    }
  </style>
  <slot name="icon">
    <slot name="on">${loopIconOn}</slot>
    <slot name="off">${loopIconOff}</slot>
  </slot>
`;
DemoLoopButton.getTooltipContentHTML = () => "Loop";

customElements.define("demo-loop-button", DemoLoopButton);
