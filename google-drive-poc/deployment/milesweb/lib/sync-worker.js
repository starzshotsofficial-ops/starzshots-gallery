"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream/promises");

const { safeSegment } = require("./gallery-cache");
const { normalizeName } = require("./drive-client");
const { sourceSignature } = require("./config-store");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "tif", "tiff"]);
const FOLDER_MIME = "application/vnd.google-apps.folder";

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
        try {
          await cache.writeSyncState(slug, {
            ...cache.readSyncState(slug),
            status: "error",
            error: error.message,
            finishedAt: new Date().toISOString()
          });
        } catch {
          // The event may have been deleted mid-sync; nothing more to record.
        }
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
    const configuredNames = Array.isArray(gallery.sceneFolderNames) ? gallery.sceneFolderNames.filter(Boolean) : [];
    const discoveredScenes = await discoverScenes(eventFolderId, configuredNames);
    const removedIds = new Set(cache.readRemovedIds(slug));

    const scenes = [];
    const pending = [];
    let sceneNumber = 0;

    for (const discovered of discoveredScenes) {
      const imageFiles = discovered.files.filter((file) => !removedIds.has(file.id));
      if (!imageFiles.length) continue;

      sceneNumber += 1;
      const images = imageFiles
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
        .map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: Number(file.size || 0) }));

      const dirName = safeSegment(discovered.name);
      await cache.writeScene(slug, sceneNumber, images);
      scenes.push({ number: sceneNumber, name: discovered.name, dirName, folderId: discovered.folderId, count: images.length });

      for (const file of imageFiles) {
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

  // Walks the event folder tree so nested sub-folders (Event > Album > Card 1 > ...) each become a scene automatically.
  async function discoverScenes(eventFolderId, configuredNames) {
    if (configuredNames.length) {
      const childFolders = await drive.listFiles(eventFolderId, true);
      const byName = new Map(childFolders.map((folder) => [normalizeName(folder.name), folder]));
      const scenes = [];
      for (const name of configuredNames) {
        const folder = byName.get(normalizeName(name));
        if (folder) scenes.push(...(await collectScenes(folder.id, folder.name)));
      }
      return scenes;
    }
    return collectScenes(eventFolderId, "");
  }

  async function collectScenes(folderId, prefix) {
    const entries = await drive.listFiles(folderId, false);
    const subfolders = entries.filter((entry) => entry.mimeType === FOLDER_MIME);
    const imageFiles = entries.filter(isImage);

    const scenes = [];
    if (imageFiles.length) scenes.push({ name: prefix || "Photos", folderId, files: imageFiles });
    for (const subfolder of subfolders) {
      const childPrefix = prefix ? `${prefix} / ${subfolder.name}` : subfolder.name;
      scenes.push(...(await collectScenes(subfolder.id, childPrefix)));
    }
    return scenes;
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
