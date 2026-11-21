// Port: start and stop a local model server.

/**
 * What the launcher knows about the server it started:
 * - running: a server process started here has not exited;
 * - started: a server process was started here (it may have exited since);
 * - log:     where its output goes, once one was started;
 * - problem: why it couldn't be started (a missing file, a spawn error), or null.
 *
 * @typedef {{running: boolean, started: boolean, log: string | null, problem: string | null}} LaunchState
 */

/**
 * Starts a model server and remembers it. One launcher owns at most one server; only a server it started is
 * stopped. start() doesn't wait for the server to answer and records problems in state() instead of throwing
 * (it throws only on misconfiguration, such as a root that isn't a URL, or a workspace it can't write).
 *
 * @interface
 */
export class ModelLauncher {
  /**
   * Start a server for the alias, listening where root points.
   * @param {{launch: import("../model.js").LaunchSettings, alias: string, root: string, workspace: string}} request
   */
  start(request) { throw new Error("ModelLauncher.start is not implemented"); }
  /** @returns {LaunchState} */
  state() { throw new Error("ModelLauncher.state is not implemented"); }
  /** Stop the server started here, if it is still running. Never throws. */
  stop() { throw new Error("ModelLauncher.stop is not implemented"); }
}
