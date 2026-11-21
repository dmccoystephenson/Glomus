// ModelEndpoint over HTTP, for an OpenAI-compatible server (llama.cpp's llama-server, or a shared server
// that speaks the same API).
import { rootOf } from "../core.js";
import { ModelEndpoint } from "../ports/model-endpoint.js";

const authHeaders = (config) => (config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {});

async function fetchJson(url, ms = 3000, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw Object.assign(new Error(`${url} answered ${res.status}`), { status: res.status });
  return res.json();
}

/** The body, or why there is none: 401/403 refused the key, 503 is busy or paused, anything else is absent. */
async function answer(get) {
  try { return { ok: true, value: await get() }; }
  catch (error) {
    return { ok: false, failure: error.status === 401 || error.status === 403 ? "refused" : error.status === 503 ? "busy" : "absent" };
  }
}

export class OpenAiCompatEndpoint extends ModelEndpoint {
  models(config) { return answer(() => fetchJson(config.baseUrl + "/models", 3000, authHeaders(config))); }
  health(config, { timeoutMs = 3000 } = {}) { return answer(() => fetchJson(rootOf(config.baseUrl) + "/health", timeoutMs)); }
  slots(config) { return answer(() => fetchJson(rootOf(config.baseUrl) + "/slots")); }
}
