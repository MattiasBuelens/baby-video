// Worker for test/errors.html?worker: creates the MediaSource in a dedicated
// worker, and runs the page's commands on it.
import { BabyMediaSource } from "../src/worker";
import { ErrorsSource, type ErrorsSourceCommand } from "./errors-source";

const mediaSource = new BabyMediaSource();
const handle = mediaSource.handle;
postMessage({ type: "handle", handle }, [handle.port]);

const source = new ErrorsSource(mediaSource);
addEventListener("message", async (event: MessageEvent) => {
  const { id, command } = event.data as {
    id: number;
    command: ErrorsSourceCommand;
  };
  try {
    await source.run(command);
    postMessage({ type: "done", id });
  } catch (e) {
    postMessage({ type: "done", id, error: String(e) });
  }
});
