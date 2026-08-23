// Intentionally tiny. OpenCode iterates every named export of the main entry
// and rejects anything that isn't a `Plugin` function, so the only thing this
// module exposes is the default plugin. Library/utility exports live in
// `./lib` (see lib.ts), which OpenCode never inspects.
export { default } from "./opencode.js";
