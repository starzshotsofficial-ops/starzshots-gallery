"use strict";

/**
 * Runtime auto-setup so the feature works from a plain `npm start` with no manual
 * `npm install` / `npm run setup`. On first start (when needed) it:
 *   1. installs @vladmandic/face-api + jpeg-js into face_recognition/node_modules
 *   2. downloads the model weights into face_recognition/models
 * Both run in the background and are guarded so concurrent Passenger workers don't
 * install twice. When everything is already present this is a fast no-op.
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

  function depsInstalled() {
    try {
      require.resolve("@vladmandic/face-api/dist/face-api.node-wasm.js");
      require.resolve("@tensorflow/tfjs");
      require.resolve("@tensorflow/tfjs-backend-wasm");
      require.resolve("jpeg-js");
      return true;
    } catch {
      return false;
    }
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
      logger.log("[face] installing face-recognition dependencies (one-time)…");
      const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], {
        cwd: moduleDir,
        stdio: "ignore",
        shell: true
      });
      child.on("error", (error) => {
        state.deps = "error";
        state.error = `Could not auto-install face packages (${error.message}). Run 'npm install' inside face_recognition once.`;
        logger.error(`[face] ${state.error}`);
        resolve(false);
      });
      child.on("close", (code) => {
        if (code === 0 && depsInstalled()) {
          state.deps = "ready";
          logger.log("[face] dependencies installed.");
          resolve(true);
        } else {
          state.deps = "error";
          state.error = `npm install exited with code ${code}. Run 'npm install' inside face_recognition once.`;
          logger.error(`[face] ${state.error}`);
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
