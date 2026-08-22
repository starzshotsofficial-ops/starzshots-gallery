"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream/promises");

// sharp is native; if it is unavailable the raw original is cached instead so the app still works.
let sharp = null;
try {
  sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(1);
} catch {
  sharp = null;
}

function isAvailable() {
  return Boolean(sharp);
}

/** Streams `source` into a JPEG at `targetPath`, longest edge capped to `size`. */
async function writeResized(source, targetPath, size) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.part`;

  if (sharp) {
    const transformer = sharp()
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true });
    await pipeline(source, transformer, fs.createWriteStream(tempPath));
  } else {
    await pipeline(source, fs.createWriteStream(tempPath));
  }

  await fsp.rename(tempPath, targetPath);
}

module.exports = { writeResized, isAvailable };
