// The model server's values: the config that names it, and the model description the Pi agent is given.
// Plain data, no I/O.

/**
 * What config/model.json (with model.local.json and the environment over it) says. loadConfig (service.js)
 * builds it.
 *
 * @typedef {Object} ModelConfig
 * @property {string} baseUrl        The OpenAI-compatible API root, e.g. "http://127.0.0.1:8080/v1".
 * @property {string} alias          The model name the server must serve.
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {LaunchSettings} [launch] How to start a local server when nothing answers at baseUrl. Only the
 *   launcher adapter reads it.
 * @property {string} apiKey         Not enumerable: it never shows up when the config is logged, saved or sent
 *   to the page. It only ever goes in an Authorization header.
 */

/**
 * @typedef {Object} LaunchSettings
 * @property {string} executable
 * @property {string} model
 * @property {string[]} [args]
 */

/**
 * What status() answers.
 *
 * @typedef {{ready: true, model: string} | {ready: false, busy?: true, reason: string}} ModelStatus
 */

/** The model description the Pi agent streams replies from (an OpenAI-compatible local server). */
export function localModel(config) {
  return {
    id: config.alias, name: config.alias, api: "openai-completions", provider: "local",
    baseUrl: config.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow || 32768, maxTokens: config.maxTokens || 3000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false,
      supportsStrictMode: false, maxTokensField: "max_tokens" },
  };
}
