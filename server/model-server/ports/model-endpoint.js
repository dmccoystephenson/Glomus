// Port: what does the model server say about itself?

/**
 * An answer from the model server: the parsed JSON body, or why there is none. Expected outcomes are values,
 * never exceptions:
 * - "refused": the server turned the API key down (HTTP 401 or 403);
 * - "busy":    the server is busy or paused (HTTP 503);
 * - "absent":  anything else: nothing listening, a timeout, another status, a body that isn't JSON.
 *
 * @typedef {{ok: true, value: any} | {ok: false, failure: "refused" | "busy" | "absent"}} Answer
 */

/**
 * The model server's self-description. Each method makes one request and resolves to an Answer; none rejects.
 * Each may take up to its timeout (3 s unless given). The API key, if the config has one, is sent only to
 * models(), and only as an Authorization header.
 *
 * @interface
 */
export class ModelEndpoint {
  /** The OpenAI-compatible model list (GET <baseUrl>/models). @param {import("../model.js").ModelConfig} config @returns {Promise<Answer>} */
  async models(config) { throw new Error("ModelEndpoint.models is not implemented"); }
  /** The server's health (GET <root>/health), which may report {paused: true}. @param {import("../model.js").ModelConfig} config @param {{timeoutMs?: number}} [options] @returns {Promise<Answer>} */
  async health(config, options) { throw new Error("ModelEndpoint.health is not implemented"); }
  /** llama.cpp's slot list (GET <root>/slots), each slot with is_processing. @param {import("../model.js").ModelConfig} config @returns {Promise<Answer>} */
  async slots(config) { throw new Error("ModelEndpoint.slots is not implemented"); }
}
