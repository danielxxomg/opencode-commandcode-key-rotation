/**
 * commandcode-key-rotation — OpenCode server plugin entry.
 *
 * Re-exports the server plugin so opencode can load it as
 * `commandcode-key-rotation/server` or `commandcode-key-rotation`.
 */

export { default as server } from "./server.js"
export { createServerPlugin } from "./server.js"
export type { KeyEntry, KeysJsonData, KeyState, ServerPluginOptions } from "./server.js"
