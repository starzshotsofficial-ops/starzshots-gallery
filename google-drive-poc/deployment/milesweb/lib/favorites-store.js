"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

/**
 * Persists per-viewer favorites so a client sees the same selections on every device.
 * On-disk layout (relative to DATA_DIR):
 *   favorites/<event-slug>.json  ->  { "<role>:<viewerId>": { ids: [...], updatedAt } }
 */
function createFavoritesStore(dataDir) {
  const favoritesDir = path.join(dataDir, "favorites");
  const writeChains = new Map();

  function filePath(slug) {
    return path.join(favoritesDir, `${safeSegment(slug)}.json`);
  }

  function viewerKey(role, viewerId) {
    return `${String(role || "").trim()}:${String(viewerId || "").trim().toLowerCase()}`;
  }

  function readAll(slug) {
    try {
      const file = filePath(slug);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) || {} : {};
    } catch {
      return {};
    }
  }

  function read(slug, role, viewerId) {
    const entry = readAll(slug)[viewerKey(role, viewerId)];
    return Array.isArray(entry?.ids) ? entry.ids : [];
  }

  // Serialize writes per gallery so concurrent devices never clobber the file mid-write.
  function write(slug, role, viewerId, ids) {
    const previous = writeChains.get(slug) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => persist(slug, role, viewerId, ids));
    writeChains.set(slug, next);
    return next;
  }

  async function persist(slug, role, viewerId, ids) {
    const all = readAll(slug);
    const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean))];
    all[viewerKey(role, viewerId)] = { ids: cleanIds, updatedAt: new Date().toISOString() };

    const file = filePath(slug);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tempPath = `${file}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(all), "utf8");
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

module.exports = { createFavoritesStore };
