// ReplyStream through pi-ai's streamSimple, which speaks to the server named by the model description
// (localModel: an OpenAI-compatible server).
import { streamSimple } from "@mariozechner/pi-ai";
import { ReplyStream } from "../ports/reply-stream.js";

export class PiReplyStream extends ReplyStream {
  stream(model, context, options) { return streamSimple(model, context, options); }
}
