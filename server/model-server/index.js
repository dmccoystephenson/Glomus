// The model server: find it, or start one from config/model.json, say whether it's ready, and stream the
// model's replies.
//
// Architecture (ports and adapters):
//
//   server.js, tools/eval.js, shaper.js
//        |
//        v
//   service.js  (loadConfig; createModelServer wires the production adapters by default)
//        |
//        v
//   core.js     (pure: what the server's answers and the launcher's state mean)   model.js (values)
//        |
//        v
//   ports/      ModelEndpoint  ModelLauncher  ReplyStream  Clock     (one interface per file)
//        ^
//        |
//   adapters/   OpenAiCompatEndpoint  LlamaServerLauncher  PiReplyStream  SystemClock   (one per file;
//               the registry by name is adapters/index.js)
//
// model.js, core.js and ports/ never import adapters/ or service.js (game/tools/model_layers_test.js checks).
// To add a model backend: one adapter file in adapters/, one entry in adapters/index.js.
import { createModelServer, loadConfig } from "./service.js";

const server = createModelServer();

export { createModelServer, loadConfig };
export { localModel } from "./model.js";
/** @type {(config: import("./model.js").ModelConfig) => Promise<import("./model.js").ModelStatus>} */
export const status = (config) => server.status(config);
/** Start llama-server unless something already answers at baseUrl. Only a server started here is stopped later. */
export const ensureStarted = (config, workspace) => server.ensureStarted(config, workspace);
export const stop = () => server.stop();
/** The production reply stream and clock: shapeWhim's defaults. */
export const replyStream = server.replies;
export const clock = server.clock;
