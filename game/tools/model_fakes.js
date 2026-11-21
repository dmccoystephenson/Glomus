// Test stand-ins for the model server's ports (server/model-server/ports), so the model server and whims can be
// tested with no model and no real time. Used by model_ports_test.js and whim_scripted_test.js.
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { Clock } from "../../server/model-server/ports/clock.js";
import { ModelEndpoint } from "../../server/model-server/ports/model-endpoint.js";
import { ModelLauncher } from "../../server/model-server/ports/model-launcher.js";
import { ReplyStream } from "../../server/model-server/ports/reply-stream.js";

/** A model server that answers what it's told: each of models/health/slots is an Answer, or absent. */
export class FakeEndpoint extends ModelEndpoint {
  constructor({ models, health, slots } = {}) {
    super();
    const absent = { ok: false, failure: "absent" };
    this.answers = { models: models || absent, health: health || absent, slots: slots || absent };
    this.calls = [];
  }
  async models(config) { this.calls.push(["models"]); return this.answers.models; }
  async health(config, options) { this.calls.push(["health", options || {}]); return this.answers.health; }
  async slots(config) { this.calls.push(["slots"]); return this.answers.slots; }
}

/** A launcher that records what it was asked to start; its state is whatever the test sets. */
export class FakeLauncher extends ModelLauncher {
  constructor(state = {}) {
    super();
    this.current = { running: false, started: false, log: null, problem: null, ...state };
    this.starts = [];
    this.stops = 0;
  }
  start(request) { this.starts.push(request); this.current = { ...this.current, running: true, started: true, log: request.workspace + "/fake.log" }; }
  state() { return { ...this.current }; }
  stop() { this.stops++; if (this.current.running) this.current = { ...this.current, running: false }; }
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** An assistant message as pi-ai builds one. */
export function assistantMessage(model, content, stopReason, errorMessage) {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: USAGE, stopReason,
    ...(errorMessage ? { errorMessage } : {}), timestamp: 0 };
}

/**
 * Model replies from a script, one step per reply. A step is a list of tool calls ([{name, arguments}]), a
 * string (a text reply that ends the turn), {error: "message"} (a reply that fails on the way), or a function
 * of the context returning one of those. When the script runs out, the reply is the text "(script over)".
 * contexts holds what each request was sent.
 */
export class ScriptedReplies extends ReplyStream {
  constructor(steps) {
    super();
    this.steps = steps.slice();
    this.contexts = [];
  }
  stream(model, context, options = {}) {
    this.contexts.push(context);
    let step = this.steps.length ? this.steps.shift() : "(script over)";
    if (typeof step === "function") step = step(context);
    const out = createAssistantMessageEventStream();
    const n = this.contexts.length;
    // Like a reply over the network, it arrives on a later turn of the event loop, not straight away.
    setTimeout(() => {
      if (options.signal && options.signal.aborted) {
        out.push({ type: "error", reason: "aborted", error: assistantMessage(model, [], "aborted", "Request was aborted.") });
        return;
      }
      out.push({ type: "start", partial: assistantMessage(model, [], "stop") });
      if (step && step.error) {
        out.push({ type: "error", reason: "error", error: assistantMessage(model, [], "error", step.error) });
      } else if (typeof step === "string") {
        out.push({ type: "done", reason: "stop", message: assistantMessage(model, [{ type: "text", text: step }], "stop") });
      } else {
        const calls = step.map((c, i) => ({ type: "toolCall", id: `call_${n}_${i}`, name: c.name, arguments: c.arguments }));
        out.push({ type: "done", reason: "toolUse", message: assistantMessage(model, calls, "toolUse") });
      }
    }, 0);
    return out;
  }
}

/** A clock that only moves when the test says so. advance(ms) runs, in time order, every callback that falls due. */
export class FakeClock extends Clock {
  constructor(t = 0) {
    super();
    this.t = t;
    this.timers = [];
    this.seq = 0;
  }
  now() { return this.t; }
  after(ms, fn) {
    const timer = { at: this.t + Math.max(0, Number(ms) || 0), seq: this.seq++, fn, live: true };
    this.timers.push(timer);
    return { cancel: () => { timer.live = false; } };
  }
  /** Timers still waiting. */
  get pending() { return this.timers.filter((t) => t.live).length; }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      due.live = false;
      due.fn();
      await new Promise((r) => setImmediate(r));   // Let whatever the callback woke run before the next one.
    }
    this.t = end;
  }
}
