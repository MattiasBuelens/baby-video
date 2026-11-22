/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Turns on verbose logging in the media pipeline, see media-pipeline.ts.
  readonly VITE_DEBUG?: string;
}

declare module "*.css?inline" {
  const stylesheet: string;
  export default stylesheet;
}

declare module "*?worker&url" {
  const workletUrl: string;
  export default workletUrl;
}
