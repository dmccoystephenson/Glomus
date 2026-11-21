// The model server's policy, with no I/O: what the server's answers (through the ModelEndpoint port) and the
// launcher's state (through the ModelLauncher port) mean for the player. service.js asks the ports and calls
// these in order.

/** The server root: baseUrl without its trailing /v1. */
export const rootOf = (baseUrl) => baseUrl.replace(/\/v1\/?$/, "");

/** Whether a /models answer lists the alias; null when the answer can't be read as a model list. */
export function servesAlias(list, alias) {
  try { return (list.data || []).some((m) => m.id === alias); } catch { return null; }
}

/** Some shared servers report a pause (their owner needs the GPU) on /health. */
export const isPaused = (health) => !!(health && health.paused === true);

/** Whether llama.cpp's /slots shows a slot at work. Anything that isn't a slot list means free. */
export function slotsBusy(slots) {
  try { return Array.isArray(slots) && slots.some((s) => s.is_processing); } catch { return false; }
}

export const ready = (alias) => ({ ready: true, model: alias });
export const notServed = (root, alias) => ({ ready: false, reason: `The model server on ${root} is running, but not as "${alias}".` });
export const pausedStatus = () => ({ ready: false, busy: true, reason: "The model server is paused for now; try again later." });
export const busyStatus = () => ({ ready: false, busy: true, reason: "The local model is busy." });

/**
 * Why the model list couldn't be had, for the player. failure is the endpoint's ("refused", "busy" or
 * "absent"); launch is the launcher's state ({running, started, log, problem}).
 */
export function unreachable(root, failure, launch) {
  if (failure === "refused") return { ready: false, reason: `The model server on ${root} refused the API key.` };
  if (failure === "busy") return { ready: false, busy: true, reason: `The model server on ${root} is busy or paused; try again later.` };
  if (launch.running) return { ready: false, reason: "The local model is starting up (usually under a minute)." };
  if (launch.started) return { ready: false, reason: "The local model server stopped while starting; see " + launch.log };
  if (launch.problem) return { ready: false, reason: "Couldn't start the local model: " + launch.problem };
  return { ready: false, reason: `No local model at ${root}.` };
}
