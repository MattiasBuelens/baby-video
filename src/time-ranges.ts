export type TimeRange = readonly [number, number];

export class TimeRanges {
  readonly #ranges: ReadonlyArray<TimeRange>;

  constructor(ranges: ReadonlyArray<TimeRange>) {
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

  find(time: number): readonly [number, number] | undefined {
    for (const [start, end] of this.#ranges) {
      if (start > time) {
        break;
      } else if (time <= end) {
        return [start, end];
      }
    }
    return undefined;
  }

  contains(time: number): boolean {
    return this.find(time) !== undefined;
  }

  containsRange(rangeStart: number, rangeEnd: number): boolean {
    return this.#ranges.some(
      ([start, end]) => start <= rangeStart && rangeEnd <= end
    );
  }

  containsRangeEndingAt(rangeEnd: number): boolean {
    return this.#ranges.some(([_, end]) => rangeEnd === end);
  }

  intersect(other: TimeRanges): TimeRanges {
    // Based on TimeRanges::intersection from Mozilla Firefox
    // https://hg.mozilla.org/releases/mozilla-release/file/bd079aadd3fe/dom/html/TimeRanges.cpp#l137
    let index1 = 0;
    let index2 = 0;
    const ranges: TimeRange[] = [];
    while (index1 < this.length && index2 < other.length) {
      const start = Math.max(this.start(index1), other.start(index2));
      const end = Math.min(this.end(index1), other.end(index2));
      if (start < end) {
        ranges.push([start, end]);
      }
      if (this.end(index1) === other.end(index2)) {
        index1 += 1;
        index2 += 1;
      } else if (this.end(index1) < other.end(index2)) {
        index1 += 1;
      } else {
        index2 += 1;
      }
    }
    return new TimeRanges(ranges);
  }

  union(other: TimeRanges, tolerance: number = 0): TimeRanges {
    if (this.length === 0) {
      return other;
    }
    if (other.length === 0) {
      return this;
    }
    // Merge sorted inputs (we assume that the inputs are normalized)
    const sorted = this.#mergeSorted(other);
    // Merge overlaps
    return sorted.mergeOverlaps(tolerance);
  }

  #mergeSorted(other: TimeRanges): TimeRanges {
    // Based on merge sort (assuming both inputs are already sorted)
    const ranges: TimeRange[] = [];
    let index1 = 0;
    let index2 = 0;
    while (index1 < this.length && index2 < other.length) {
      const start1 = this.start(index1);
      const end1 = this.end(index1);
      const start2 = other.start(index2);
      const end2 = other.end(index2);
      if (start1 < start2 || (start1 === start2 && end1 < end2)) {
        ranges.push([start1, end1]);
        index1++;
      } else {
        ranges.push([start2, end2]);
        index2++;
      }
    }
    ranges.push(...this.#ranges.slice(index1));
    ranges.push(...other.#ranges.slice(index2));
    return new TimeRanges(ranges);
  }

  mergeOverlaps(tolerance: number = 0): TimeRanges {
    // Based on this::normalize from Mozilla Firefox
    // https://hg.mozilla.org/releases/mozilla-release/file/33c11529607b/dom/html/TimeRanges.cpp#l112
    const length = this.length;
    if (length < 2) {
      return this;
    }
    const ranges: TimeRange[] = [];
    let currentStart = this.start(0);
    let currentEnd = this.end(0);
    for (let index = 1; index < length; index++) {
      const newStart = this.start(index);
      const newEnd = this.end(index);
      // Skip if new range is completely contained in current range
      if (currentStart <= newStart && currentEnd >= newEnd) {
        continue;
      }
      if (currentEnd + tolerance >= newStart) {
        // Extend current range
        currentEnd = newEnd;
      } else {
        // Finish current range
        ranges.push([currentStart, currentEnd]);
        currentStart = newStart;
        currentEnd = newEnd;
      }
    }
    // Finish last range
    ranges.push([currentStart, currentEnd]);
    return new TimeRanges(ranges);
  }

  invert(): TimeRanges {
    if (this.length === 0) {
      return new TimeRanges([[-Infinity, +Infinity]]);
    }
    const ranges: TimeRange[] = [];
    if (this.#ranges[0][0] > -Infinity) {
      ranges.push([-Infinity, this.#ranges[0][0]]);
    }
    for (let i = 1; i < this.#ranges.length; i++) {
      ranges.push([this.#ranges[i - 1][1], this.#ranges[i][0]]);
    }
    if (this.#ranges[this.#ranges.length - 1][1] < Infinity) {
      ranges.push([this.#ranges[this.#ranges.length - 1][1], Infinity]);
    }
    return new TimeRanges(ranges);
  }

  subtract(other: TimeRanges): TimeRanges {
    return this.intersect(other.invert());
  }
}

export function setEndTimeOnLastRange(
  timeRanges: TimeRanges,
  newEndTime: number
): TimeRanges {
  if (timeRanges.length === 0) {
    return timeRanges;
  }
  return timeRanges.union(
    new TimeRanges([[timeRanges.end(timeRanges.length - 1), newEndTime]])
  );
}
