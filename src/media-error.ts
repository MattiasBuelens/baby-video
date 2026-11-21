// https://html.spec.whatwg.org/multipage/media.html#error-codes
// The error status of a BabyVideoElement, like MediaError.
export class BabyMediaError {
  // The fetching process for the media resource was aborted by the user agent at the user's request.
  static readonly MEDIA_ERR_ABORTED = 1;
  // A network error of some description caused the user agent to stop fetching the media resource,
  // after the resource was established to be usable.
  static readonly MEDIA_ERR_NETWORK = 2;
  // An error of some description occurred while decoding the media resource,
  // after the resource was established to be usable.
  static readonly MEDIA_ERR_DECODE = 3;
  // The media resource indicated by the src attribute or assigned media provider object was not suitable.
  static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  declare readonly MEDIA_ERR_ABORTED: 1;
  declare readonly MEDIA_ERR_NETWORK: 2;
  declare readonly MEDIA_ERR_DECODE: 3;
  declare readonly MEDIA_ERR_SRC_NOT_SUPPORTED: 4;

  readonly #code: number;
  readonly #message: string;

  // https://html.spec.whatwg.org/multipage/media.html#creating-a-mediaerror
  // To create a MediaError, given an error code which is one of the above values,
  // return a new MediaError object whose code is the given error code and whose message
  // is a string containing any details the user agent is able to supply about the cause
  // of the error condition, or the empty string if the user agent is unable to supply such details.
  constructor(code: number, message: string = "") {
    this.#code = code;
    this.#message = message;
  }

  get code(): number {
    return this.#code;
  }

  get message(): string {
    return this.#message;
  }
}

// Like the constants of a WebIDL interface, these are also on the prototype.
for (const name of [
  "MEDIA_ERR_ABORTED",
  "MEDIA_ERR_NETWORK",
  "MEDIA_ERR_DECODE",
  "MEDIA_ERR_SRC_NOT_SUPPORTED"
] as const) {
  Object.defineProperty(BabyMediaError.prototype, name, {
    value: BabyMediaError[name],
    enumerable: true
  });
}
