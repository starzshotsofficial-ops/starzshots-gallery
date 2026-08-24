"use strict";

/**
 * Optional CLI: downloads the model weights into ./models.
 *
 * You normally do NOT need this — the server auto-downloads the models on first
 * start. Kept for offline / air-gapped setups.
 *
 *   node download-models.js          # core models (tiny detector)
 *   node download-models.js --ssd    # also fetch the heavier SSD detector
 */

const path = require("path");
const { downloadModels } = require("./lib/models");

const MODELS_DIR = path.join(__dirname, "models");

downloadModels({
  modelsDir: MODELS_DIR,
  ssd: process.argv.includes("--ssd"),
  onProgress: ({ file, done, total }) => {
    if (file) process.stdout.write(`Downloading ${file} (${done + 1}/${total}) ...\n`);
  }
})
  .then(() => console.log(`\nModels ready in ${MODELS_DIR}`))
  .catch((error) => {
    console.error(`\nModel download failed: ${error.message}`);
    process.exit(1);
  });
