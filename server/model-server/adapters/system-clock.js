// Clock on the machine's own time and timers.
import { Clock } from "../ports/clock.js";

export class SystemClock extends Clock {
  now() { return Date.now(); }
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
}
