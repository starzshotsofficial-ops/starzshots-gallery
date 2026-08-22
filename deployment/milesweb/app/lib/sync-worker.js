"use strict";

const fs = require("fs");

const { safeSegment } = require("./gallery-cache");
const { sourceSignature } = require("./config-store");
const { entryHash, entryName, entrySize } = require("./spacebyte-client");
const imageProcessor = require("./image-processor");

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Background job that mirrors the SpaceByte listing plus a low-resolution thumbnail for
 * every photo into DATA_DIR. Runs one event at a time with a small download concurrency
 * so resizing thousands of photos never saturates a shared-hosting container.
 */
function createSyncWorker({ config, cache, client, thumbnailSize, concurrency, refreshMinutes, logger = console }) {
  const queue = [];
  const queued = new Set();
  const forceFlags = new Set();
  let running = false;

  function status(slug) {
    const state = cache.readSyncState(slug);
    return { ...state, queued: queued.has(slug), running: running && queue[0] === slug };
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

    const eventFolder = await client.resolveEventFolder(gallery);
    const childFolders = await client.listFolders(eventFolder.id);
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
      const entries = await client.listImages(folder.id);
      const images = entries
        .map((entry, index) => ({ id: entryHash(entry), name: entryName(entry, index), size: entrySize(entry) }))
        .filter((image) => image.id)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

      const dirName = safeSegment(sceneName);
      await cache.writeScene(slug, sceneNumber, images);
      scenes.push({ number: sceneNumber, name: sceneName, dirName, folderId: String(folder.id), count: images.length });

      for (const image of images) {
        const targetPath = cache.thumbnailPath(slug, dirName, image.id);
        if (!force && fs.existsSync(targetPath)) continue;
        pending.push({ image, targetPath });
      }
    }

    const totalImages = scenes.reduce((sum, scene) => sum + scene.count, 0);
    await cache.writeIndex(slug, {
      slug,
      eventName: gallery.eventName,
      eventFolderId: String(eventFolder.id),
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
        await cacheThumbnail(job.image, job.targetPath);
      } catch (error) {
        failed += 1;
        logger.warn(`[sync] ${slug}: thumbnail for '${job.image.name}' failed (${error.message}). It will load from SpaceByte on demand.`);
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

  async function cacheThumbnail(image, targetPath) {
    const source = await client.streamDownload(image.id);
    if (source.statusCode < 200 || source.statusCode >= 300) {
      source.resume();
      throw new Error(`SpaceByte returned status ${source.statusCode}.`);
    }
    await imageProcessor.writeResized(source, targetPath, thumbnailSize);
  }

  function enqueueStale() {
    for (const gallery of config.list()) {
      const index = cache.readIndex(gallery.slug);
      if (!index || index.signature !== sourceSignature(gallery)) enqueue(gallery.slug);
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
