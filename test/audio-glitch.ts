// Test page for detecting gaps and crackles in the audio output.
// Driven by test/audio-glitch.spec.mjs, see there for details.
import { BabyMediaSource, BabyVideoElement } from "../src/index";
import { waitForEvent } from "../src/util";
import audioUrl from "./fixtures/sine-440.m4a?url";
import videoUrl from "./fixtures/video.m4v?url";

// Tap every node that connects to an AudioContext's destination,
// and record what it outputs.
const recorded: Float32Array[] = [];
let recording = false;
const originalConnect = AudioNode.prototype.connect as (
  this: AudioNode,
  ...args: any[]
) => any;
AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
  const destination = args[0];
  if (destination instanceof AudioDestinationNode) {
    const context = this.context as AudioContext;
    // ScriptProcessorNode is deprecated, but it can be set up synchronously.
    const tap = context.createScriptProcessor(4096, 1, 1);
    tap.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      event.outputBuffer.getChannelData(0).set(input);
      if (recording) {
        recorded.push(input.slice());
      }
    };
    originalConnect.call(this, tap);
    originalConnect.call(tap, destination);
    return destination;
  }
  return originalConnect.apply(this, args);
} as typeof AudioNode.prototype.connect;

const video = document.querySelector<BabyVideoElement>("baby-video")!;
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
  recording = true;
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  recording = false;
  video.pause();
  const total = recorded.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of recorded) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { sampleRate: 48000, samples: Array.from(samples) };
};
document.body.dataset.ready = "true";
