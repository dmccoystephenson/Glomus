// Port: stream one model reply.

/**
 * Streams one assistant reply. The contract is pi-ai's StreamFunction, the one Pi's Agent takes as streamFn:
 * stream(model, context, options) returns (or resolves to) an AssistantMessageEventStream: "start", then text
 * and tool-call events, then exactly one "done" (with the finished message) or "error" (with the failed
 * message, stopReason "error" or "aborted"). A failure on the way arrives as an "error" event, not an
 * exception. options.signal aborts the reply. That library type is the contract here on purpose: the agent
 * loop consumes it unchanged.
 *
 * @interface
 */
export class ReplyStream {
  /** @param {object} model localModel(config) @param {object} context {systemPrompt, messages, tools} @param {object} [options] {signal, apiKey, ...} */
  stream(model, context, options) { throw new Error("ReplyStream.stream is not implemented"); }
}
