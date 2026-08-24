"use strict";

/**
 * Wraps @vladmandic/face-api with a pure-JS TensorFlow.js backend so it runs on
 * shared hosting (MilesWeb / Passenger) without any native modules.
 *
 * Thumbnails and selfies are decoded with jpeg-js (pure JS) into an int32 RGB
 * tensor, then face-api detects faces, aligns them with 68 landmarks and returns
 * a 128-float descriptor per face. Two faces belong to the same person when the
 * Euclidean distance between their descriptors is below `matchThreshold`.
 *
 * The heavy packages are require()d lazily so the app still boots (and can run its
 * own auto-install) before they are present on disk.
 */

const path = require("path");

function createFaceEngine({
  modelsDir,
  detector = "tiny",
  minConfidence = 0.5,
  matchThreshold = 0.5
}) {
  let faceapi = null;
  let jpeg = null;
  let tf = null;
  let loadPromise = null;

  function loadPackages() {
    if (!faceapi) {
      // The package default (dist/face-api.node.js) pulls the NATIVE @tensorflow/tfjs-node,
      // which cannot be installed on shared hosting. node-wasm.js is the pure-JS build.
      faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      jpeg = require("jpeg-js");
      tf = faceapi.tf;
    }
  }

  /** WASM is much faster than the plain JS CPU kernels; fall back to CPU if it cannot start. */
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

  async function ensureLoaded() {
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
      : new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: minConfidence });
  }

  /** Decodes a JPEG buffer into an int32 [height, width, 3] RGB tensor. Caller must dispose. */
  function decodeToTensor(buffer) {
    const { width, height, data } = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    const pixelCount = width * height;
    const rgb = new Int32Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i += 1) {
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
    }
    return tf.tensor3d(rgb, [height, width, 3], "int32");
  }

  /** Returns a 128-float descriptor for every face found in the image. */
  async function describeAll(buffer) {
    await ensureLoaded();
    const tensor = decodeToTensor(buffer);
    try {
      const results = await faceapi
        .detectAllFaces(tensor, detectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
      return results.map((result) => Array.from(result.descriptor));
    } finally {
      tensor.dispose();
    }
  }

  /** Returns the descriptor of the single most prominent face (used for the selfie). */
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
