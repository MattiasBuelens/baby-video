// Test page for detecting gaps and crackles in the audio output.
// Driven by test/audio-glitch.spec.mjs, see there for details.
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { waitForEvent } from "../src/util";
import audioUrl from "./fixtures/sine-440.m4a?url";
import videoUrl from "./fixtures/video.m4v?url";

// Tap every node that connects to an AudioContext's destination,
// and record what it outputs. The recorder runs in an AudioWorklet on the audio
// thread, so (unlike a ScriptProcessorNode) a busy main thread can't make it
// drop or duplicate samples.
const recorderSource = `
registerProcessor("recorder", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.port.onmessage = (event) => {
      this.recording = event.data;
      if (!this.recording) this.flush();
    };
  }
  flush() {
    if (this.length > 0) this.port.postMessage(this.buffer.slice(0, this.length));
    this.length = 0;
  }
  process(inputs) {
    const input = inputs[0][0];
    if (this.recording) {
      // An input without active connections has no channels: record silence.
      for (let i = 0; i < 128; i++) {
        this.buffer[this.length++] = input ? input[i] : 0;
        if (this.length === this.buffer.length) this.flush();
      }
    }
    return true;
  }
});
`;
const recorderUrl = URL.createObjectURL(
  new Blob([recorderSource], { type: "text/javascript" })
);
const recorded: Float32Array[] = [];
const recorders: AudioWorkletNode[] = [];
let recordedSampleRate = 48000;
const originalConnect = AudioNode.prototype.connect as (
  this: AudioNode,
  ...args: any[]
) => any;
AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
  const destination = args[0];
  if (destination instanceof AudioDestinationNode) {
    const source = this;
    const context = source.context as AudioContext;
    recordedSampleRate = context.sampleRate;
    void context.audioWorklet.addModule(recorderUrl).then(() => {
      const recorder = new AudioWorkletNode(context, "recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit"
      });
      recorder.port.onmessage = (event) => recorded.push(event.data);
      originalConnect.call(source, recorder);
      recorders.push(recorder);
    });
  }
  return originalConnect.apply(this, args);
} as typeof AudioNode.prototype.connect;

function setRecording(recording: boolean) {
  for (const recorder of recorders) {
    recorder.port.postMessage(recording);
  }
}

const video = document.querySelector<BabyVideoElement>("baby-video")!;
if (new URLSearchParams(location.search).has("worker")) {
  // Create the MediaSource in a dedicated worker, see media-source-worker.ts.
  const worker = new Worker(
    new URL("./media-source-worker.ts", import.meta.url),
    {
      type: "module"
    }
  );
  await new Promise<void>((resolve) => {
    worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data.type === "handle") {
        video.srcObject = event.data.handle;
      } else if (event.data.type === "ready") {
        resolve();
      }
    });
  });
  // The worker has appended all media data, but the element only learns about
  // that one message later.
  if (video.readyState < 4) {
    await waitForEvent(video, "canplaythrough");
  }
} else {
  const mediaSource = new BabyMediaSource();
  video.srcObject = mediaSource;
  if (mediaSource.readyState !== "open") {
    await waitForEvent(mediaSource, "sourceopen");
  }
  async function append(type: string, url: string) {
    const sourceBuffer = mediaSource.addSourceBuffer(type);
    sourceBuffer.appendBuffer(await (await fetch(url)).arrayBuffer());
    await waitForEvent(sourceBuffer, "updateend");
  }
  await Promise.all([
    append('video/mp4; codecs="avc1.64000d"', videoUrl),
    append('audio/mp4; codecs="mp4a.40.2"', audioUrl)
  ]);
  mediaSource.endOfStream();
}

declare global {
  interface Window {
    recordPlayback(options: {
      start: number;
      playbackRate: number;
      seconds: number;
    }): Promise<{ sampleRate: number; samples: number[] }>;
  }
}

window.recordPlayback = async ({ start, playbackRate, seconds }) => {
  video.pause();
  video.playbackRate = playbackRate;
  video.currentTime = start;
  if (video.seeking) {
    await waitForEvent(video, "seeked");
  }
  recorded.length = 0;
  setRecording(true);
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  setRecording(false);
  video.pause();
  // Wait for the recorder to send its last samples.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const total = recorded.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of recorded) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { sampleRate: recordedSampleRate, samples: Array.from(samples) };
};
document.body.dataset.ready = "true";
