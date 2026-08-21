"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream/promises");

const { safeSegment } = require("./gallery-cache");
const { normalizeName } = require("./drive-client");
const { sourceSignature } = require("./config-store");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff"]);

/**
 * Background job that mirrors the Drive listing plus a low-resolution thumbnail for
 * every photo into DATA_DIR. Runs one event at a time so a 2000-photo sync never
 * saturates a shared-hosting container.
 */
function createSyncWorker({ config, cache, drive, thumbnailSize, concurrency, refreshMinutes, logger = console }) {
  const queue = [];
  const queued = new Set();
  const forceFlags = new Set();
  let running = false;

  function status(slug) {
    const state = cache.readSyncState(slug);
    return {
      ...state,
      queued: queued.has(slug),
      running: running && queue[0] === slug
    };
  }

  function enqueue(slug, { force = false } = {}) {
    if (!config.find(slug)) return false;
    if (queued.has(slug)) return true;

    queued.add(slug);
    queue.push(slug);
    if (force) forceFlags.add(slug);
    void drain();
    return true;
  }

  async function drain() {
    if (running) return;
    running = true;

    while (queue.length) {
      const slug = queue[0];
      const force = forceFlags.delete(slug);
      try {
        await syncGallery(slug, force);
      } catch (error) {
        logger.error(`[sync] ${slug} failed: ${error.message}`);
        await cache.writeSyncState(slug, {
          ...cache.readSyncState(slug),
          status: "error",
          error: error.message,
          finishedAt: new Date().toISOString()
        });
      } finally {
        queue.shift();
        queued.delete(slug);
      }
    }

    running = false;
  }

  async function syncGallery(slug, force) {
    const gallery = config.find(slug);
    if (!gallery) return;

    const startedAt = new Date().toISOString();
    await cache.writeSyncState(slug, { status: "listing", startedAt, totalImages: 0, cachedThumbnails: 0, error: "" });

    const eventFolderId = await drive.resolveEventFolderId(gallery);
    const childFolders = await drive.listFiles(eventFolderId, true);
    const configuredScenes =
      Array.isArray(gallery.sceneFolderNames) && gallery.sceneFolderNames.length
        ? gallery.sceneFolderNames
        : childFolders.map((folder) => folder.name);

    const foldersByName = new Map(childFolders.map((folder) => [normalizeName(folder.name), folder]));
    const scenes = [];
    const pending = [];
    let sceneNumber = 0;

    for (const sceneName of configuredScenes) {
      const folder = foldersByName.get(normalizeName(sceneName));
      if (!folder) continue;

      sceneNumber += 1;
      const files = await drive.listFiles(folder.id, false);
      const images = files
        .filter(isImage)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
        .map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: Number(file.size || 0) }));

      const dirName = safeSegment(sceneName);
      await cache.writeScene(slug, sceneNumber, images);
      scenes.push({ number: sceneNumber, name: sceneName, dirName, folderId: folder.id, count: images.length });

      for (const file of files.filter(isImage)) {
        const targetPath = cache.thumbnailPath(slug, dirName, file.id);
        if (!force && fs.existsSync(targetPath)) continue;
        pending.push({ file, targetPath });
      }
    }

    const totalImages = scenes.reduce((sum, scene) => sum + scene.count, 0);
    await cache.writeIndex(slug, {
      slug,
      eventName: gallery.eventName,
      eventFolderId,
      signature: sourceSignature(gallery),
      syncedAt: new Date().toISOString(),
      totalImages,
      scenes
    });

    let cached = totalImages - pending.length;
    let failed = 0;
    await cache.writeSyncState(slug, { status: "caching", startedAt, totalImages, cachedThumbnails: cached, error: "" });

    await runWithConcurrency(pending, concurrency, async (job) => {
      try {
        await cacheThumbnail(job.file, job.targetPath);
      } catch (error) {
        failed += 1;
        logger.warn(`[sync] ${slug}: thumbnail for '${job.file.name}' failed (${error.message}). It will load from Drive on demand.`);
      }

      cached += 1;
      if (cached % 25 === 0) {
        await cache.writeSyncState(slug, { status: "caching", startedAt, totalImages, cachedThumbnails: cached, error: "" });
      }
    });

    await cache.writeSyncState(slug, {
      status: "ready",
      startedAt,
      finishedAt: new Date().toISOString(),
      totalImages,
      cachedThumbnails: cached,
      failedThumbnails: failed,
      error: ""
    });

    logger.log(`[sync] ${slug}: ${totalImages} photos indexed, ${cached - failed} thumbnails cached, ${failed} deferred.`);
  }

  async function cacheThumbnail(file, targetPath) {
    const source = await drive.streamThumbnail(file.thumbnailLink, thumbnailSize);
    if (!source || source.statusCode < 200 || source.statusCode >= 300) {
      source?.resume();
      throw new Error(`Drive returned status ${source?.statusCode || "none"}.`);
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.part`;
    await pipeline(source, fs.createWriteStream(tempPath));
    await fsp.rename(tempPath, targetPath);
  }

  function enqueueStale() {
    for (const gallery of config.list()) {
      const index = cache.readIndex(gallery.slug);
      if (!index || index.signature !== sourceSignature(gallery)) {
        enqueue(gallery.slug);
      }
    }
  }

  function start() {
    enqueueStale();
    if (refreshMinutes > 0) {
      const timer = setInterval(() => config.list().forEach((gallery) => enqueue(gallery.slug)), refreshMinutes * 60_000);
      timer.unref();
    }
  }

  return { enqueue, status, start };
}

function isImage(file) {
  if (String(file.mimeType || "").startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(path.extname(file.name || "").slice(1).toLowerCase());
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    })
  );
}

module.exports = { createSyncWorker };
