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
