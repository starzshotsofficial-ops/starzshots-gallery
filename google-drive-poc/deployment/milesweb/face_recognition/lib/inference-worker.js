"use strict";

/**
 * Runs all face detection / description on a dedicated worker thread so the
 * CPU-bound WASM inference never blocks the main event loop that serves the
 * gallery. The main thread only does async Drive I/O and posts image buffers
 * here; this worker replies with descriptors.
 */

const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const { modelsDir, detector, minConfidence, minFaceSize, minScore, detectorInputSize } = workerData;

let faceapi = null;
let jpeg = null;
let tf = null;
let loadPromise = null;

function loadPackages() {
  if (!faceapi) {
    faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
    jpeg = require("jpeg-js");
    tf = faceapi.tf;
  }
}

async function selectBackend() {
  try {
    const wasm = require("@tensorflow/tfjs-backend-wasm");
    const wasmDist = path.join(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm/package.json")), "dist");
    wasm.setWasmPaths(wasmDist + path.sep);
    if (await tf.setBackend("wasm")) {
      await tf.ready();
      return;
    }
  } catch {
    // Fall through to the always-available CPU backend.
  }
  await tf.setBackend("cpu");
  await tf.ready();
}

function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      loadPackages();
      await selectBackend();
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir);
      if (detector === "ssd") await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsDir);
      else await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir);
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

function detectorOptions() {
  return detector === "ssd"
    ? new faceapi.SsdMobilenetv1Options({ minConfidence })
    : new faceapi.TinyFaceDetectorOptions({ inputSize: detectorInputSize || 608, scoreThreshold: minConfidence });
}

function decodeToTensor(buffer) {
  const { width, height, data } = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const pixelCount = width * height;
  const rgb = new Int32Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i += 1) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3], "int32");
}

async function describeAll(buffer) {
  await ensureLoaded();
  const tensor = decodeToTensor(buffer);
  try {
    const results = await faceapi
      .detectAllFaces(tensor, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
    return results
      .filter((result) => {
        const box = result.detection.box;
        return Math.min(box.width, box.height) >= minFaceSize && result.detection.score >= minScore;
      })
      .map((result) => Array.from(result.descriptor));
  } finally {
    tensor.dispose();
  }
}

async function describeLargest(buffer) {
  await ensureLoaded();
  const tensor = decodeToTensor(buffer);
  try {
    const result = await faceapi
      .detectSingleFace(tensor, detectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? Array.from(result.descriptor) : null;
  } finally {
    tensor.dispose();
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
