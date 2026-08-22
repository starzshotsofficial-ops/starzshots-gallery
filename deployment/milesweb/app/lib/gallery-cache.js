"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

/**
 * On-disk layout (all relative to DATA_DIR):
 *   thumbnails/<event-slug>/<scene-folder>/<fileId>.jpg   cached grid thumbnails
 *   previews/<event-slug>/<scene-folder>/<fileId>.jpg     cached lightbox previews (lazy)
 *   index/<event-slug>/index.json                         scene summary + sync signature
 *   index/<event-slug>/scene-<n>.json                     per-scene image list (kept out of index.json
 *                                                         so a 2000-photo scene is never fully parsed
 *                                                         just to render the scene tabs)
 *   index/<event-slug>/sync-state.json                    background job progress
 */
function createGalleryCache(dataDir) {
  const thumbnailsDir = path.join(dataDir, "thumbnails");
  const previewsDir = path.join(dataDir, "previews");
  const indexDir = path.join(dataDir, "index");
  const sceneCache = new Map();

  function eventIndexDir(slug) {
    return path.join(indexDir, safeSegment(slug));
  }

  function indexPath(slug) {
    return path.join(eventIndexDir(slug), "index.json");
  }

  function scenePath(slug, sceneNumber) {
    return path.join(eventIndexDir(slug), `scene-${sceneNumber}.json`);
  }

  function syncStatePath(slug) {
    return path.join(eventIndexDir(slug), "sync-state.json");
  }

  function thumbnailPath(slug, sceneDirName, fileId) {
    return path.join(thumbnailsDir, safeSegment(slug), safeSegment(sceneDirName), `${safeSegment(fileId)}.jpg`);
  }

  function previewPath(slug, sceneDirName, fileId) {
    return path.join(previewsDir, safeSegment(slug), safeSegment(sceneDirName), `${safeSegment(fileId)}.jpg`);
  }

  function readIndex(slug) {
    return readJson(indexPath(slug));
  }

  async function writeIndex(slug, index) {
    await writeJson(indexPath(slug), index);
    sceneCache.clear();
  }

  async function writeScene(slug, sceneNumber, images) {
    await writeJson(scenePath(slug, sceneNumber), { images });
    sceneCache.delete(`${slug}:${sceneNumber}`);
  }

  function readScene(slug, sceneNumber) {
    const key = `${slug}:${sceneNumber}`;
    const cached = sceneCache.get(key);
    if (cached) return cached;

    const payload = readJson(scenePath(slug, sceneNumber));
    const images = payload?.images || [];
    if (sceneCache.size > 12) sceneCache.clear();
    sceneCache.set(key, images);
    return images;
  }

  function readSyncState(slug) {
    return readJson(syncStatePath(slug)) || { status: "never-run", totalImages: 0, cachedThumbnails: 0 };
  }

  function writeSyncState(slug, state) {
    return writeJson(syncStatePath(slug), state);
  }

  /** Finds an image descriptor without parsing every scene file when the scene is already known. */
  function findImage(slug, fileId) {
    const index = readIndex(slug);
    if (!index) return null;

    for (const scene of index.scenes || []) {
      const images = readScene(slug, scene.number);
      const image = images.find((entry) => entry.id === fileId);
      if (image) return { image, scene };
    }
    return null;
  }

  function page(slug, sceneName, offset, limit) {
    const index = readIndex(slug);
    if (!index) return { total: 0, images: [] };

    const scenes = (index.scenes || []).filter((scene) => sceneName === "all" || scene.name === sceneName);
    const total = scenes.reduce((sum, scene) => sum + scene.count, 0);
    const images = [];
    let cursor = 0;

    for (const scene of scenes) {
      if (images.length >= limit) break;
      if (cursor + scene.count <= offset) {
        cursor += scene.count;
        continue;
      }

      const sceneImages = readScene(slug, scene.number);
      const startIndex = Math.max(0, offset - cursor);
      const endIndex = Math.min(sceneImages.length, startIndex + (limit - images.length));

      for (let position = startIndex; position < endIndex; position += 1) {
        images.push(describe(scene, sceneImages[position], position));
      }
      cursor += scene.count;
    }

    return { total, images };
  }

  function imagesByIds(slug, ids) {
    const index = readIndex(slug);
    if (!index) return [];

    const wanted = new Set(ids);
    const results = [];

    for (const scene of index.scenes || []) {
      if (!wanted.size) break;
      const sceneImages = readScene(slug, scene.number);
      sceneImages.forEach((image, position) => {
        if (!wanted.has(image.id)) return;
        wanted.delete(image.id);
        results.push(describe(scene, image, position));
      });
    }

    return results;
  }

  function allImages(slug) {
    const index = readIndex(slug);
    if (!index) return [];
    return (index.scenes || []).flatMap((scene) => readScene(slug, scene.number).map((image, position) => describe(scene, image, position)));
  }

  function describe(scene, image, position) {
    return {
      id: image.id,
      filename: image.name,
      scene: scene.name,
      sceneDir: scene.dirName,
      sceneIndex: position + 1,
      size: Number(image.size || 0)
    };
  }

  async function remove(slug) {
    await Promise.all([
      fsp.rm(eventIndexDir(slug), { recursive: true, force: true }),
      fsp.rm(path.join(thumbnailsDir, safeSegment(slug)), { recursive: true, force: true }),
      fsp.rm(path.join(previewsDir, safeSegment(slug)), { recursive: true, force: true })
    ]);
    sceneCache.clear();
  }

  return {
    thumbnailPath,
    previewPath,
    readIndex,
    writeIndex,
    readScene,
    writeScene,
    readSyncState,
    writeSyncState,
    findImage,
    page,
    imagesByIds,
    allImages,
    remove
  };
}

function readJson(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
  } catch {
    return null;
  }
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(payload), "utf8");
  await fsp.rename(tempPath, filePath);
}

function safeSegment(value) {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned || "_";
}

module.exports = { createGalleryCache, safeSegment };
