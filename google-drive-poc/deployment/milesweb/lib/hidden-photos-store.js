"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

/**
 * Persists hidden photos per event (client hides photos from guests).
 * On-disk layout (relative to DATA_DIR):
 *   hidden/<event-slug>.json  ->  { hiddenIds: [...], updatedAt }
 */
function createHiddenPhotosStore(dataDir) {
  const hiddenDir = path.join(dataDir, "hidden");
  const writeChains = new Map();

  function filePath(slug) {
    return path.join(hiddenDir, `${safeSegment(slug)}.json`);
  }

  function readAll(slug) {
    try {
      const file = filePath(slug);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) || {} : {};
    } catch {
      return {};
    }
  }

  function read(slug) {
    const data = readAll(slug);
    return Array.isArray(data.hiddenIds) ? data.hiddenIds : [];
  }

  // Serialize writes per gallery so concurrent updates never clobber the file mid-write.
  function write(slug, ids) {
    const previous = writeChains.get(slug) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => persist(slug, ids));
    writeChains.set(slug, next);
    return next;
  }

  async function persist(slug, ids) {
    const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean))];
    const data = { hiddenIds: cleanIds, updatedAt: new Date().toISOString() };

    const file = filePath(slug);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tempPath = `${file}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(data), "utf8");
    await fsp.rename(tempPath, file);
    return cleanIds;
  }

  return { read, write };
}

function safeSegment(value) {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned || "_";
}

module.exports = { createHiddenPhotosStore };
