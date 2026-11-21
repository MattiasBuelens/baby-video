// Checks BabyMediaSourceHandle, for a BabyMediaSource in a dedicated worker.
import { test, expect } from "@playwright/test";

test("attach and detach a MediaSource in a worker", async ({ page }) => {
  page.on("pageerror", (err) => console.error("[page]", err));
  await page.goto("test/handle.html");
  await page.waitForSelector("body[data-ready]");
  const result = await page.evaluate(() => window.result);
  expect(result).toMatchObject({
    canConstructInDedicatedWorkerInWindow: true,
    canConstructInDedicatedWorker: true,
    sameHandle: true,
    // Like a real MediaSourceHandle, a handle can only be transferred once...
    secondTransferError: "DataCloneError",
    // ...and only be attached once. Loading a used handle fails with
    // MEDIA_ERR_SRC_NOT_SUPPORTED, and rejects pending play promises.
    secondAttachError: "NotSupportedError",
    secondAttachErrorCode: 4,
    secondAttachNetworkState: 3,
    messages: ["handle", "info", "sourceopen", "sourceclose"]
  });
});
