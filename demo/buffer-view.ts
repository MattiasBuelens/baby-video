import type { BabySourceBuffer, BabyVideoElement } from "../src/index";
import type { TimeRanges } from "../src/time-ranges";

export interface BufferTrack {
  label: string;
  className: string;
  buffered: () => TimeRanges;
  /**
   * The SourceBuffer behind this track, if any.
   * The view listens for its `updateend` events to redraw after an append or remove.
   */
  sourceBuffer?: BabySourceBuffer;
}

/** How many seconds of the timeline the zoomed view shows. */
const windowSize = 80;

export function sourceBufferTrack(
  label: string,
  className: string,
  sourceBuffer: BabySourceBuffer
): BufferTrack {
  return {
    label,
    className,
    buffered: () => sourceBuffer.buffered,
    sourceBuffer
  };
}

export function setupBufferView(
  video: BabyVideoElement,
  container: HTMLElement,
  tracks: BufferTrack[]
): void {
  const overview = container.querySelector<HTMLElement>(".buffer-overview")!;
  const zoomed = container.querySelector<HTMLElement>(".buffer-zoomed")!;
  const axis = container.querySelector<HTMLElement>(".buffer-axis")!;
  const summary = container.querySelector<HTMLElement>(".buffer-summary")!;

  // Build one row per track in both views.
  const overviewRows = tracks.map((track) => createRow(overview, track));
  const zoomedRows = tracks.map((track) => createRow(zoomed, track));
  const overviewPlayhead = createPlayhead(overview);
  // Outline the part of the overview that the zoomed view shows.
  const overviewWindow = document.createElement("div");
  overviewWindow.className = "buffer-window";
  overviewPlayhead.before(overviewWindow);
  const zoomedPlayhead = createPlayhead(zoomed);

  function render() {
    const duration = video.duration;
    const currentTime = video.currentTime;
    if (Number.isFinite(duration) && duration > 0) {
      // Overview: the whole stream.
      tracks.forEach((track, i) => {
        renderRanges(overviewRows[i], track.buffered(), 0, duration);
      });
      overviewPlayhead.style.left = percent(currentTime / duration);
      const windowStart = currentTime - windowSize / 2;
      overviewWindow.style.left = percent(windowStart / duration);
      overviewWindow.style.width = percent(windowSize / duration);

      // Zoomed: a window centered on the playhead.
      tracks.forEach((track, i) => {
        renderRanges(
          zoomedRows[i],
          track.buffered(),
          windowStart,
          windowStart + windowSize
        );
      });
      zoomedPlayhead.style.left = "50%";
      renderAxis(axis, windowStart, windowStart + windowSize, duration);
      renderSummary(summary, video, tracks[0].buffered());
    }
  }

  // Only redraw when the playhead or a buffer changes,
  // coalescing multiple events into a single redraw per frame.
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }
  for (const type of [
    "durationchange",
    "emptied",
    "progress",
    "ratechange",
    "seeked",
    "seeking",
    "timeupdate"
  ]) {
    video.addEventListener(type, scheduleRender);
  }
  for (const track of tracks) {
    track.sourceBuffer?.addEventListener("updateend", scheduleRender);
  }
  scheduleRender();
}

function createRow(parent: HTMLElement, track: BufferTrack): HTMLElement {
  const row = document.createElement("div");
  row.className = `buffer-row ${track.className}`;
  const label = document.createElement("span");
  label.className = "buffer-row-label";
  label.textContent = track.label;
  const bar = document.createElement("div");
  bar.className = "buffer-row-bar";
  row.append(label, bar);
  parent.append(row);
  return bar;
}

function createPlayhead(parent: HTMLElement): HTMLElement {
  const track = document.createElement("div");
  track.className = "buffer-playhead-track";
  const playhead = document.createElement("div");
  playhead.className = "buffer-playhead";
  track.append(playhead);
  parent.append(track);
  return playhead;
}

function renderRanges(
  bar: HTMLElement,
  ranges: TimeRanges,
  viewStart: number,
  viewEnd: number
) {
  const viewSize = viewEnd - viewStart;
  const segments: HTMLElement[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const start = Math.max(ranges.start(i), viewStart);
    const end = Math.min(ranges.end(i), viewEnd);
    if (end <= start) continue;
    const segment = document.createElement("div");
    segment.className = "buffer-range";
    segment.style.left = percent((start - viewStart) / viewSize);
    segment.style.width = percent((end - start) / viewSize);
    segments.push(segment);
  }
  bar.replaceChildren(...segments);
}

function renderAxis(
  axis: HTMLElement,
  viewStart: number,
  viewEnd: number,
  duration: number
) {
  const step = 10;
  const ticks: HTMLElement[] = [];
  for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) {
    if (t < 0 || t > duration) continue;
    const tick = document.createElement("span");
    tick.className = "buffer-tick";
    tick.style.left = percent((t - viewStart) / (viewEnd - viewStart));
    tick.textContent = formatTime(t);
    ticks.push(tick);
  }
  axis.replaceChildren(...ticks);
}

function renderSummary(
  summary: HTMLElement,
  video: BabyVideoElement,
  buffered: TimeRanges
) {
  const range = buffered.find(video.currentTime);
  const behind = range ? video.currentTime - range[0] : 0;
  const ahead = range ? range[1] - video.currentTime : 0;
  const reverse = video.playbackRate < 0;
  const direction = reverse ? "⏪ reverse" : "▶️ forward";
  const inFront = reverse ? behind : ahead;
  const text = `${direction} · ${inFront.toFixed(1)}s buffered in the direction of playback`;
  if (summary.textContent !== text) {
    summary.textContent = text;
  }
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
