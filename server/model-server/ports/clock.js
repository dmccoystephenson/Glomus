// Port: what time is it, and wake me later.

/**
 * Time for retries, stall timers and the whim's work budget.
 * - now(): milliseconds since the epoch; never decreases between calls on one clock.
 * - after(ms, fn): call fn once, ms from now, unless the returned handle is cancelled first. Never calls fn
 *   synchronously. cancel() is safe to call more than once, and after fn ran.
 *
 * @interface
 */
export class Clock {
  /** @returns {number} */
  now() { throw new Error("Clock.now is not implemented"); }
  /** @param {number} ms @param {() => void} fn @returns {{cancel: () => void}} */
  after(ms, fn) { throw new Error("Clock.after is not implemented"); }
}
