"use strict";

/**
 * Runtime auto-setup so the feature works from a plain `npm start` with no manual
 * `npm install`. On first start (when needed) it:
 *   1. installs @vladmandic/human + jpeg-js into face_recognition/node_modules
 *   2. downloads the model weights into face_recognition/models (once, then loaded
 *      from local disk on every subsequent boot — no CDN dependency at runtime)
 * The install is guarded so concurrent Passenger workers don't install twice.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");

const { modelsInstalled, downloadModels } = require("./models");

const LOCK_STALE_MS = 20 * 60 * 1000;
const RETRY_COOLDOWN_MS = 30 * 1000;

function createSetup({ moduleDir, modelsDir, logger = console, autoInstall = true }) {
  const lockPath = path.join(moduleDir, ".setup.lock");
  const state = { deps: "unknown", models: "unknown", error: "", progress: null };
  let running = null;
  let cooldownUntil = 0;

  // Returns the list of missing/unresolvable dependencies (empty = all present).
  function missingDeps() {
    const missing = [];
    try {
      // Resolve the bare package (allowed by exports), then check the node-wasm build's presence.
      const mainEntry = require.resolve("@vladmandic/human");
      const wasmEntry = path.join(path.dirname(mainEntry), "human.node-wasm.js");
      if (!fs.existsSync(wasmEntry)) missing.push(`human.node-wasm.js (missing at ${wasmEntry})`);
    } catch (error) {
      missing.push(`@vladmandic/human (${error.code || error.message})`);
    }
    for (const dep of ["@tensorflow/tfjs", "@tensorflow/tfjs-backend-wasm", "jpeg-js"]) {
      try {
        require.resolve(dep);
      } catch (error) {
        missing.push(`${dep} (${error.code || error.message})`);
      }
    }
    return missing;
  }

  function depsInstalled() {
    return missingDeps().length === 0;
  }

  function ready() {
    return depsInstalled() && modelsInstalled(modelsDir);
  }

  function snapshot() {
    return {
      deps: depsInstalled() ? "ready" : state.deps,
      models: modelsInstalled(modelsDir) ? "ready" : state.models,
      ready: ready(),
      error: state.error,
      progress: state.progress
    };
  }

  function lockHeld() {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      return age < LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  async function withLock(task) {
    if (lockHeld()) return false;
    try {
      await fsp.writeFile(lockPath, String(process.pid));
    } catch {
      // If we cannot write the lock we still try the task; worst case is a duplicate install.
    }
    try {
      await task();
      return true;
    } finally {
      await fsp.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  function installDeps() {
    return new Promise((resolve) => {
      state.deps = "installing";
      logger.log(`[face] installing dependencies (one-time) in ${moduleDir} …`);
      let output = "";
      const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], {
        cwd: moduleDir,
        shell: true
      });
      if (child.stdout) child.stdout.on("data", (chunk) => { output += chunk; });
      if (child.stderr) child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => {
        state.deps = "error";
        state.error = `Could not auto-install face packages (${error.message}). Run 'npm install' inside face_recognition once.`;
        logger.error(`[face] ${state.error}`);
        resolve(false);
      });
      child.on("close", (code) => {
        const missing = missingDeps();
        if (code === 0 && missing.length === 0) {
          state.deps = "ready";
          logger.log("[face] dependencies installed.");
          resolve(true);
        } else {
          state.deps = "error";
          state.error = `npm install exited with code ${code}; still missing: ${missing.join(", ") || "none"}`;
          logger.error(`[face] ${state.error}`);
          logger.error(`[face] npm output (tail):\n${output.slice(-3000)}`);
          resolve(false);
        }
      });
    });
  }

  async function fetchModels() {
    state.models = "downloading";
    logger.log("[face] downloading face models (one-time)…");
    await downloadModels({
      modelsDir,
      onProgress: (info) => {
        state.progress = { phase: "models", file: info.file, done: info.done, total: info.total };
      }
    });
    state.models = "ready";
    state.progress = null;
    logger.log("[face] models ready.");
  }

  /** Kicks off setup in the background if anything is missing. Resolves to the readiness. */
  function ensureReady() {
    if (ready()) {
      state.deps = "ready";
      state.models = "ready";
      return Promise.resolve(true);
    }
    logger.log(`[face] not ready yet; missing: ${missingDeps().join(", ") || "none"}`);
    if (running) return running;
    if (Date.now() < cooldownUntil) return Promise.resolve(false);

    running = withLock(async () => {
      try {
        if (!depsInstalled()) {
          if (!autoInstall) {
            state.deps = "error";
            state.error = "Face packages are not installed and auto-install is disabled.";
          } else {
            await installDeps();
          }
        }
        if (depsInstalled() && !modelsInstalled(modelsDir)) await fetchModels();
      } catch (error) {
        state.error = error.message;
        logger.error(`[face] setup failed: ${error.message}`);
      }
    }).then(
      () => ready(),
      () => false
    ).finally(() => {
      running = null;
      if (!ready()) cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
    });

    return running;
  }

  return { ensureReady, ready, depsInstalled, snapshot };
}

module.exports = { createSetup };
