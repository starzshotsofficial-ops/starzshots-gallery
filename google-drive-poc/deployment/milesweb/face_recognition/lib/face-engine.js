"use strict";

/**
 * Proxy in front of the inference worker thread. All heavy face detection /
 * description runs in lib/inference-worker.js so the gallery's event loop stays
 * responsive while a (possibly hours-long) index build is running.
 *
 * Faces are matched by Euclidean distance between 128-float descriptors; below
 * `matchThreshold` = same person.
 */

const path = require("path");
const { Worker } = require("worker_threads");

function createFaceEngine({
  modelsDir,
  detector = "tiny",
  minConfidence = 0.5,
  matchThreshold = 0.5,
  minFaceSize = 34,
  minScore = 0.55,
  detectorInputSize = 608
}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, "inference-worker.js"), {
      workerData: { modelsDir, detector, minConfidence, minFaceSize, minScore, detectorInputSize }
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

  function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  return { ensureLoaded, describeAll, describeLargest, distance, matchThreshold };
}

module.exports = { createFaceEngine };
