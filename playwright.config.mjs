import { defineConfig, devices } from "@playwright/test";

const port = 5173;

const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: {
    args: ["--autoplay-policy=no-user-gesture-required"]
  }
};

export default defineConfig({
  testDir: "test",
  testMatch: "*.spec.mjs",
  // The audio tests record real-time playback, so give them some room.
  timeout: 30_000,
  // Audio is played (and recorded) in real time, so don't compete for the CPU.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // On CI, the github reporter only adds failure annotations, and Playwright
  // would add its default "dot" reporter for the log. Use "list" there too.
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${port}/baby-video/`,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: chromium
    },
    {
      // Same tests, with the MediaSource (and the media pipeline) in a worker.
      name: "chromium-worker",
      use: chromium,
      metadata: { query: "?worker" },
      // Already tests the worker on its own.
      testIgnore: "handle.spec.mjs"
    }
  ],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/baby-video/`,
    reuseExistingServer: !process.env.CI
  }
});
