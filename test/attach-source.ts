import { BabyMediaSource } from "../src/index";
import { SourceDriver, type SourceCommand } from "./source-driver";

// Attaches a new BabyMediaSource to the element, on the main thread,
// or in a worker with ?worker. Returns a function to run commands on it.
export async function attachSource(
  video: HTMLElement & { srcObject: unknown }
): Promise<{
  run: (command: SourceCommand) => Promise<void>;
  // Only on the main thread.
  mediaSource: BabyMediaSource | undefined;
}> {
  if (!new URLSearchParams(location.search).has("worker")) {
    const mediaSource = new BabyMediaSource();
    video.srcObject = mediaSource;
    const driver = new SourceDriver(mediaSource);
    return { run: (command) => driver.run(command), mediaSource };
  }
  const worker = new Worker(
    new URL("./source-driver-worker.ts", import.meta.url),
    { type: "module" }
  );
  let nextId = 0;
  const pending = new Map<number, (error?: string) => void>();
  await new Promise<void>((resolve) => {
    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "handle") {
        video.srcObject = message.handle;
        resolve();
      } else if (message.type === "done") {
        pending.get(message.id)!(message.error);
        pending.delete(message.id);
      }
    });
  });
  const run = (command: SourceCommand) =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (error) =>
        error ? reject(new Error(error)) : resolve()
      );
      worker.postMessage({ id, command });
    });
  return { run, mediaSource: undefined };
}
