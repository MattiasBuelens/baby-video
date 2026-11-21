// Worker for attachSource() with ?worker: creates the MediaSource in a
// dedicated worker, and runs the page's commands on it.
import { BabyMediaSource } from "../src/worker";
import { SourceDriver, type SourceCommand } from "./source-driver";

const mediaSource = new BabyMediaSource();
const handle = mediaSource.handle;
postMessage({ type: "handle", handle }, [handle.port]);

const source = new SourceDriver(mediaSource);
addEventListener("message", async (event: MessageEvent) => {
  const { id, command } = event.data as {
    id: number;
    command: SourceCommand;
  };
  try {
    await source.run(command);
    postMessage({ type: "done", id });
  } catch (e) {
    postMessage({ type: "done", id, error: String(e) });
  }
});
