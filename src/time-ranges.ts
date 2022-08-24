export class TimeRanges {
  readonly #ranges: ReadonlyArray<[number, number]>;

  constructor(ranges: ReadonlyArray<[number, number]>) {
    this.#ranges = ranges;
  }

  get length(): number {
    return this.#ranges.length;
  }

  start(index: number): number {
    return this.#ranges[index][0];
  }

  end(index: number): number {
    return this.#ranges[index][1];
  }
}
