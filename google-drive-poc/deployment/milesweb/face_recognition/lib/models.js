"use strict";

/**
 * Downloads @vladmandic/human model files once into face_recognition/models so the
 * worker can load them from local disk (file://) instead of depending on the CDN
 * at every restart, which has been flaky (intermittent connect timeouts).
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const https = require("https");

const BASE_URL = "https://vladmandic.github.io/human-models/models/";

// Only the models actually enabled in inference-worker.js's humanConfig().
const CORE_FILES = ["blazeface.json", "blazeface.bin", "facemesh.json", "facemesh.bin", "faceres.json", "faceres.bin"];

function modelsInstalled(modelsDir) {
  return CORE_FILES.every((file) => fs.existsSync(path.join(modelsDir, file)));
}

function downloadFile(fileName, modelsDir, redirectsLeft = 3) {
  const url = /^https?:/i.test(fileName) ? fileName : `${BASE_URL}${fileName}`;
  const outName = /^https?:/i.test(fileName) ? path.basename(new URL(fileName).pathname) : fileName;
  const outPath = path.join(modelsDir, outName);

  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 15000 }, (response) => {
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
        const file = fs.createWriteStream(outPath);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (error) => {
          fs.rm(outPath, { force: true }, () => {});
          reject(error);
        });
      })
      .on("timeout", function onTimeout() {
        this.destroy(new Error("Connect timeout"));
      })
      .on("error", reject);
  });
}

/** Retries a single file a few times with backoff before giving up (CDN has been flaky). */
async function downloadFileWithRetry(fileName, modelsDir, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadFile(fileName, modelsDir);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

async function downloadModels({ modelsDir, onProgress } = {}) {
  await fsp.mkdir(modelsDir, { recursive: true });

  let done = 0;
  for (const fileName of CORE_FILES) {
    if (typeof onProgress === "function") onProgress({ file: fileName, done, total: CORE_FILES.length });
    // Skip files already present so a re-run is cheap.
    if (!fs.existsSync(path.join(modelsDir, fileName))) await downloadFileWithRetry(fileName, modelsDir);
    done += 1;
  }
  if (typeof onProgress === "function") onProgress({ file: "", done, total: CORE_FILES.length });
}

module.exports = { CORE_FILES, modelsInstalled, downloadModels };
