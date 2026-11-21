// The adapters, by name. service.js builds the defaults from here; a caller may pick another by name.
// To add a model backend: write one adapter file next to these (extending the port it implements) and add
// one entry below.
import { LlamaServerLauncher } from "./llama-server-launcher.js";
import { OpenAiCompatEndpoint } from "./openai-compat-endpoint.js";
import { PiReplyStream } from "./pi-reply-stream.js";
import { SystemClock } from "./system-clock.js";

export const ENDPOINTS = { "openai-compat": () => new OpenAiCompatEndpoint() };
export const LAUNCHERS = { "llama-server": () => new LlamaServerLauncher() };
export const REPLY_STREAMS = { "pi-ai": () => new PiReplyStream() };
export const CLOCKS = { system: () => new SystemClock() };

export const DEFAULTS = { endpoint: "openai-compat", launcher: "llama-server", replies: "pi-ai", clock: "system" };

export { LlamaServerLauncher, OpenAiCompatEndpoint, PiReplyStream, SystemClock };
