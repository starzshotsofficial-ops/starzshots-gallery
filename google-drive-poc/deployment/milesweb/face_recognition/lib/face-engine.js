"use strict";

/**
 * Proxy in front of the inference worker thread. All heavy face detection /
 * description runs in lib/inference-worker.js (using @vladmandic/human) so the
 * gallery's event loop stays responsive while a (possibly hours-long) index
 * build is running.
 *
 * Embeddings are L2-normalized in the worker, so faces are matched here with
 * cosine distance (1 - dot); below `matchThreshold` = same person.
 */

const path = require("path");
const { Worker } = require("worker_threads");

function createFaceEngine({
  modelBasePath,
  wasmPath,
  matchThreshold = 0.4,
  minFaceSize = 34,
  minScore = 0.4,
  maxDetected = 100
}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, "inference-worker.js"), {
      workerData: { modelBasePath, wasmPath, maxDetected, minFaceSize, minScore }
    });
    worker.on("message", (message) => {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    worker.on("error", (error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker = null; // Allow a fresh worker on the next request.
    });
    worker.on("exit", () => {
      worker = null;
    });
    return worker;
  }

  function run(type, buffer) {
    const activeWorker = ensureWorker();
    const id = ++seq;
    // Copy into a standalone ArrayBuffer we can transfer (zero-copy) to the worker.
    const transfer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      activeWorker.postMessage({ type, id, buffer: transfer }, [transfer]);
    });
  }

  async function ensureLoaded() {
    ensureWorker();
  }

  function describeAll(buffer) {
    return run("describeAll", buffer);
  }

  function describeLargest(buffer) {
    return run("describeLargest", buffer);
  }

  // Cosine distance on L2-normalized embeddings: 0 = identical, up to 2 = opposite.
  function distance(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return 1 - dot;
  }

  return { ensureLoaded, describeAll, describeLargest, distance, matchThreshold };
}

module.exports = { createFaceEngine };
