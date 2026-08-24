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

const { parentPort, workerData } = require("worker_threads");

const { modelBasePath, wasmPath, maxDetected, minFaceSize, minScore } = workerData;

let Human = null;
let jpeg = null;
let human = null;
let loadPromise = null;

function humanConfig() {
  return {
    backend: "wasm",
    wasmPath,
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
      const mod = require("@vladmandic/human");
      Human = mod.default || mod.Human;
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

function usableFace(face) {
  const score = face.faceScore ?? face.score ?? face.boxScore ?? 0;
  return Array.isArray(face.embedding) && faceSize(face) >= minFaceSize && score >= minScore;
}

async function describeAll(buffer) {
  await ensureLoaded();
  const tensor = decodeToTensor(buffer);
  try {
    const result = await human.detect(tensor);
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
    const faces = (result.face || []).filter((face) => Array.isArray(face.embedding));
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
