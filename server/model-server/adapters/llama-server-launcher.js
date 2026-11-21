// ModelLauncher that starts llama.cpp's llama-server from config/model.json's launch section.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ModelLauncher } from "../ports/model-launcher.js";

export class LlamaServerLauncher extends ModelLauncher {
  constructor() {
    super();
    this.process = null;
    this.problem = null;
    this.log = null;
  }

  start({ launch, alias, root, workspace }) {
    for (const p of [launch.executable, launch.model]) if (!fs.existsSync(p)) { this.problem = p + " is missing."; return; }
    const url = new URL(root);
    fs.mkdirSync(workspace, { recursive: true });
    this.log = path.join(workspace, "llama-server.log");
    const out = fs.openSync(this.log, "a");
    this.process = spawn(launch.executable, ["--model", launch.model, "--alias", alias, "--host", url.hostname,
      "--port", url.port || "8080", ...(launch.args || [])], { stdio: ["ignore", out, out], windowsHide: true });
    this.process.on("error", (e) => { this.problem = e.message; });
  }

  state() {
    return { running: !!this.process && this.process.exitCode === null, started: !!this.process, log: this.log, problem: this.problem };
  }

  stop() {
    if (this.process && this.process.exitCode === null) this.process.kill();
  }
}
