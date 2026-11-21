import type { BabyVideoElement } from "../src/index";

const loggedEvents = [
  "loadstart",
  "abort",
  "emptied",
  "error",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "waiting",
  "play",
  "pause",
  "playing",
  "timeupdate",
  "durationchange",
  "ratechange",
  "seeking",
  "seeked",
  "progress",
  "resize",
  "volumechange",
  "ended"
] as const;

const maxEntries = 200;

export function setupEventLog(
  video: BabyVideoElement,
  container: HTMLElement
): void {
  const list = container.querySelector<HTMLOListElement>(".event-log-list")!;
  const showTimeUpdate = container.querySelector<HTMLInputElement>(
    "input[name=show-timeupdate]"
  )!;
  const clearButton =
    container.querySelector<HTMLButtonElement>("button[name=clear]")!;
  const startTime = performance.now();

  function logEvent(event: Event) {
    if (event.type === "timeupdate" && !showTimeUpdate.checked) {
      return;
    }
    console.log(`${event.type} @ ${video.currentTime}`);

    const item = document.createElement("li");
    item.dataset.type = event.type;

    const wallTime = document.createElement("span");
    wallTime.className = "event-wall-time";
    wallTime.textContent = `${((performance.now() - startTime) / 1000).toFixed(2)}s`;

    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type;

    const detail = document.createElement("span");
    detail.className = "event-detail";
    detail.textContent = describeEvent(video, event);

    item.append(wallTime, type, detail);

    // Keep scrolled to the bottom, unless the user scrolled up.
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 4;
    list.append(item);
    while (list.childElementCount > maxEntries) {
      list.firstElementChild!.remove();
    }
    if (atBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  for (const type of loggedEvents) {
    video.addEventListener(type, logEvent);
  }
  clearButton.addEventListener("click", () => {
    list.textContent = "";
  });
}

function describeEvent(video: BabyVideoElement, event: Event): string {
  const time = `t=${video.currentTime.toFixed(3)}`;
  switch (event.type) {
    case "ratechange":
      return `${time} rate=${video.playbackRate}`;
    case "durationchange":
      return `duration=${video.duration}`;
    case "resize":
      return `${video.videoWidth}×${video.videoHeight}`;
    case "volumechange":
      return `volume=${video.volume.toFixed(2)} muted=${video.muted}`;
    case "error":
      return `code=${video.error?.code} ${video.error?.message ?? ""}`;
    default:
      return time;
  }
}
