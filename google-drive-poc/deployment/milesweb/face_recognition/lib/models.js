"use strict";

/**
 * Shared model-weight download helper used by both the CLI (download-models.js)
 * and the runtime auto-setup (setup.js). Pure Node stdlib, no dependencies.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const https = require("https");

const BASE_URL = "https://raw.githubusercontent.com/vladmandic/face-api/master/model/";

// Upstream reformatted the weights as one .bin per model (previously sharded as -shard1/-shard2).
const CORE_FILES = [
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model.bin",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model.bin"
];

const SSD_FILES = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model.bin"
];

function modelsInstalled(modelsDir) {
  const required = [
    "face_recognition_model-weights_manifest.json",
    "face_landmark_68_model-weights_manifest.json"
  ];
  const detector =
    fs.existsSync(path.join(modelsDir, "tiny_face_detector_model-weights_manifest.json")) ||
    fs.existsSync(path.join(modelsDir, "ssd_mobilenetv1_model-weights_manifest.json"));
  return detector && required.every((file) => fs.existsSync(path.join(modelsDir, file)));
}

function downloadFile(fileName, modelsDir, redirectsLeft = 3) {
  const target = path.join(modelsDir, fileName);
  const url = /^https?:/i.test(fileName) ? fileName : `${BASE_URL}${fileName}`;
  const outName = /^https?:/i.test(fileName) ? path.basename(new URL(fileName).pathname) : fileName;
  const outPath = path.join(modelsDir, outName);

  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
          response.resume();
          const next = new URL(response.headers.location, url).toString();
          downloadFile(next, modelsDir, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download ${outName} (HTTP ${response.statusCode}).`));
          return;
        }
        const file = fs.createWriteStream(target === outPath ? target : outPath);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (error) => {
          fs.rm(outPath, { force: true }, () => {});
          reject(error);
        });
      })
      .on("error", reject);
  });
}

async function downloadModels({ modelsDir, ssd = false, onProgress } = {}) {
  await fsp.mkdir(modelsDir, { recursive: true });
  const files = ssd ? [...CORE_FILES, ...SSD_FILES] : CORE_FILES;

  let done = 0;
  for (const fileName of files) {
    if (typeof onProgress === "function") onProgress({ file: fileName, done, total: files.length });
    // Skip files already present so a re-run is cheap.
    if (!fs.existsSync(path.join(modelsDir, fileName))) await downloadFile(fileName, modelsDir);
    done += 1;
  }
  if (typeof onProgress === "function") onProgress({ file: "", done, total: files.length });
}

module.exports = { CORE_FILES, SSD_FILES, modelsInstalled, downloadModels };
