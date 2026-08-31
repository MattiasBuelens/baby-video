declare module "*.css?inline" {
  const stylesheet: string;
  export default stylesheet;
}

declare module "*?worker&url" {
  const workletUrl: string;
  export default workletUrl;
}
