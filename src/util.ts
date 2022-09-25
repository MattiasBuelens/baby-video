export function toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data, 0, data.byteLength);
  } else if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new TypeError(`Unexpected buffer source: ${data}`);
  }
}

export function concatUint8Arrays(
  left: Uint8Array,
  right: Uint8Array
): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

export function queueTask(fn: () => void): void {
  setTimeout(fn, 0);
}

export function waitForEvent(
  target: EventTarget,
  type: string,
  signal?: AbortSignal
): Promise<Event> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason);
    }
    const listener = (event: Event) => {
      signal?.removeEventListener("abort", abortListener);
      resolve(event);
    };
    const abortListener = () => {
      reject(signal!.reason);
    };
    target.addEventListener(type, listener, { once: true, signal });
    signal?.addEventListener("abort", abortListener, { once: true });
  });
}

export function isDefined<T>(x: T | undefined): x is T {
  return x !== undefined;
}

export function binarySearch<T>(
  array: readonly T[],
  key: number,
  keySelector: (v: T) => number
): number {
  // Original from TypeScript by Microsoft
  // License: Apache 2.0
  // https://github.com/microsoft/TypeScript/blob/v4.8.3/src/compiler/core.ts#L1151-L1184
  let low = 0;
  let high = array.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const midKey = keySelector(array[middle]);
    if (midKey < key) {
      low = middle + 1;
    } else if (midKey > key) {
      high = middle - 1;
    } else {
      return middle;
    }
  }
  return ~low; // key not found
}

export function insertSorted<T>(
  array: T[],
  insert: T,
  keySelector: (v: T) => number,
  allowDuplicates?: boolean
): void {
  // Original from TypeScript by Microsoft
  // License: Apache 2.0
  // https://github.com/microsoft/TypeScript/blob/v4.8.3/src/compiler/core.ts#L781-L794
  if (array.length === 0) {
    array.push(insert);
    return;
  }
  const insertIndex = binarySearch(array, keySelector(insert), keySelector);
  if (insertIndex < 0) {
    array.splice(~insertIndex, 0, insert);
  } else if (allowDuplicates) {
    array.splice(insertIndex, 0, insert);
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve?: (value: T) => void;
  #reject?: (reason: any) => void;
  #followedSignals: AbortSignal[] = [];

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T) {
    this.#resolve?.(value);
    this.#cleanup();
  }

  reject(reason: any) {
    this.#reject?.(reason);
    this.#cleanup();
  }

  follow(signal: AbortSignal): void {
    if (signal.aborted) {
      return this.reject(signal.reason);
    }
    signal.addEventListener("abort", this.#handleAbort, { once: true });
    this.#followedSignals.push(signal);
  }

  #cleanup(): void {
    this.#resolve = this.#reject = undefined;
    for (const signal of this.#followedSignals) {
      signal.removeEventListener("abort", this.#handleAbort);
    }
    this.#followedSignals.length = 0;
  }

  readonly #handleAbort = (event: Event) => {
    this.reject((event.target as AbortSignal).reason);
  };
}
