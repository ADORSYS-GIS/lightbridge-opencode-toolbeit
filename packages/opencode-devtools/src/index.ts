// OpenCode plugin entry. The host iterates every named export of this module
// and rejects any export that isn't a Plugin function (or { server: Plugin }).
// Library API is exposed via the "./lib" subpath in package.json.
export { default } from "./opencode.js";
