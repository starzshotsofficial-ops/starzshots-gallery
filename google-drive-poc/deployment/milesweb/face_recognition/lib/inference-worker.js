"use strict";

/**
 * Runs all face detection / description on a dedicated worker thread (so the
 * gallery event loop stays responsive) using @vladmandic/human — a modern,
 * pure-JS/WASM successor to face-api with stronger detection and embeddings.
 *
 * Models and the WASM binaries load from a CDN by default (override with
 * FACE_MODEL_BASE_PATH / FACE_WASM_PATH), so nothing native is compiled on the host.
 *
 * Embeddings are L2-normalized here so the main thread can match with cosine
 * distance (1 - dot); lower = more similar.
 */

const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const { modelBasePath, wasmPath, maxDetected, minFaceSize, minScore } = workerData;

let Human = null;
let jpeg = null;
let human = null;
let loadPromise = null;

// Load the WASM binaries from the locally installed backend so their version matches
// the tfjs Human uses; fall back to whatever wasmPath was configured (e.g. a CDN).
function resolveWasmPath() {
  try {
    return path.join(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm/package.json")), "dist") + path.sep;
  } catch {
    return wasmPath;
  }
}

function humanConfig() {
  return {
    backend: "wasm",
    wasmPath: resolveWasmPath(),
    modelBasePath,
    cacheSensitivity: 0,
    debug: false,
    filter: { enabled: false },
    face: {
      enabled: true,
      detector: { maxDetected: maxDetected || 100, minConfidence: minScore || 0.3, rotation: false, return: false },
      mesh: { enabled: true },
      iris: { enabled: false },
      description: { enabled: true },
      emotion: { enabled: false },
      antispoof: { enabled: false },
      liveness: { enabled: false }
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false }
  };
}

function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      // The package default (dist/human.node.js) needs the NATIVE @tensorflow/tfjs-node,
      // which cannot be installed on shared hosting. node-wasm.js is the pure-JS/WASM build.
      const mod = require("@vladmandic/human/dist/human.node-wasm.js");
      Human = mod.default || mod.Human || mod;
      jpeg = require("jpeg-js");
      human = new Human(humanConfig());
      await human.load();
      await human.tf.ready();
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

/** Decodes a JPEG buffer into a Human tf int32 [height, width, 3] RGB tensor. */
function decodeToTensor(buffer) {
  const { width, height, data } = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const pixelCount = width * height;
  const rgb = new Int32Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i += 1) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  return human.tf.tensor3d(rgb, [height, width, 3], "int32");
}

function l2normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}

function faceSize(face) {
  const box = face.box || [0, 0, 0, 0];
  return Math.min(box[2], box[3]);
}

// Human returns embedding as a Float32Array (not a plain Array), so test length, not Array.isArray.
function hasEmbedding(face) {
  return face.embedding && face.embedding.length > 0;
}

function faceScoreOf(face) {
  // Default to 1 when a score field is absent so a naming difference never drops every face.
  return face.faceScore ?? face.boxScore ?? face.score ?? 1;
}

function usableFace(face) {
  return hasEmbedding(face) && faceSize(face) >= minFaceSize && faceScoreOf(face) >= minScore;
}

let diagnosed = false;
function diagnoseOnce(result) {
  if (diagnosed) return;
  diagnosed = true;
  const faces = result.face || [];
  const first = faces[0];
  console.log(
    `[face] worker diagnostic: detected=${faces.length}` +
      (first
        ? ` firstEmbeddingLen=${first.embedding ? first.embedding.length : 0} firstBox=${JSON.stringify(first.box)} faceScore=${first.faceScore} boxScore=${first.boxScore}`
        : "")
  );
}

async function describeAll(buffer) {
  await ensureLoaded();
  const tensor = decodeToTensor(buffer);
  try {
    const result = await human.detect(tensor);
    diagnoseOnce(result);
    return (result.face || []).filter(usableFace).map((face) => l2normalize(Array.from(face.embedding)));
  } finally {
    human.tf.dispose(tensor);
  }
}

async function describeLargest(buffer) {
  await ensureLoaded();
  const tensor = decodeToTensor(buffer);
  try {
    const result = await human.detect(tensor);
    const faces = (result.face || []).filter(hasEmbedding);
    if (!faces.length) return null;
    const largest = faces.reduce((best, face) => (faceSize(face) > faceSize(best) ? face : best));
    return l2normalize(Array.from(largest.embedding));
  } finally {
    human.tf.dispose(tensor);
  }
}

parentPort.on("message", async (message) => {
  const buffer = Buffer.from(message.buffer);
  try {
    const result = message.type === "describeLargest" ? await describeLargest(buffer) : await describeAll(buffer);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message });
  }
});
