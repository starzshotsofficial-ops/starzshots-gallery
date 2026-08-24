"use strict";

/**
 * Builds and stores per-gallery face descriptors on disk and answers selfie searches.
 *
 * Layout (relative to DATA_DIR): faces/<event-slug>/index.json
 *   { signature, total, updatedAt, images: [ { id, scene, sceneDir, faces: [[128 floats], ...] } ] }
 *
 * Indexing reuses the thumbnails the gallery already caches. Missing thumbnails are
 * fetched from Drive on demand and cached, so the index does not depend on the sync
 * worker having finished first. The build runs in the background with in-memory
 * progress so the client UI can poll while it works.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

function createFaceIndex({ dataDir, cache, drive, engine, thumbnailSize, logger = console, checkpointEvery = 20 }) {
  const facesDir = path.join(dataDir, "faces");
  const jobs = new Map();
  const buildQueue = [];
  const queued = new Set();
  let draining = false;

  function safe(segment) {
    return String(segment || "").replace(/[^a-z0-9._-]/gi, "_") || "_";
  }

  function indexPath(slug) {
    return path.join(facesDir, safe(slug), "index.json");
  }

  function readIndex(slug) {
    try {
      return JSON.parse(fs.readFileSync(indexPath(slug), "utf8"));
    } catch {
      return null;
    }
  }

  async function writeIndex(slug, data) {
    const target = indexPath(slug);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(data));
    await fsp.rename(temp, target);
  }

  /** A cheap fingerprint of the gallery contents so we can tell when the index is stale. */
  function signatureFor(slug) {
    const galleryIndex = cache.readIndex(slug);
    if (!galleryIndex) return "0";
    const scenes = (galleryIndex.scenes || []).map((scene) => scene.count).join(",");
    return `${galleryIndex.totalImages || 0}:${scenes}`;
  }

  function isStale(slug) {
    const index = readIndex(slug);
    return !index || index.signature !== signatureFor(slug);
  }

  async function thumbnailBuffer(slug, image) {
    const cachedPath = cache.thumbnailPath(slug, image.sceneDir, image.id);
    if (fs.existsSync(cachedPath)) return fsp.readFile(cachedPath);

    const file = await drive.getFile(image.id);
    const source = await drive.streamThumbnail(file.thumbnailLink, thumbnailSize);
    if (!source || source.statusCode < 200 || source.statusCode >= 300) {
      source?.resume();
      return null;
    }

    const chunks = [];
    for await (const chunk of source) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    await fsp.mkdir(path.dirname(cachedPath), { recursive: true });
    await fsp.writeFile(cachedPath, buffer).catch(() => {});
    return buffer;
  }

  function status(slug) {
    const job = jobs.get(slug);
    if (job && job.status === "running") {
      return { status: "indexing", processed: job.processed, total: job.total };
    }

    const index = readIndex(slug);
    if (index) {
      return {
        status: isStale(slug) ? "stale" : "ready",
        processed: index.images.length,
        total: index.total,
        updatedAt: index.updatedAt
      };
    }

    if (job && job.status === "error") return { status: "error", error: job.error };
    return { status: "empty" };
  }

  async function build(slug, { force = false } = {}) {
    if (jobs.get(slug)?.status === "running") return;

    const images = cache.allImages(slug);
    const existing = force ? null : readIndex(slug);
    const done = new Map();
    if (existing) for (const entry of existing.images) done.set(entry.id, entry);

    const job = { status: "running", processed: 0, total: images.length };
    jobs.set(slug, job);

    let reused = 0;
    let detected = 0;
    let failures = 0;
    let firstError = null;

    try {
      const results = [];
      for (const image of images) {
        job.processed += 1;

        if (done.has(image.id)) {
          reused += 1;
          results.push(done.get(image.id));
          continue;
        }

        const record = { id: image.id, scene: image.scene, sceneDir: image.sceneDir, faces: [] };
        try {
          const buffer = await thumbnailBuffer(slug, image);
          if (buffer) record.faces = await engine.describeAll(buffer);
          detected += record.faces.length;
        } catch (error) {
          failures += 1;
          if (!firstError) firstError = error;
        }
        results.push(record);

        if (job.processed % checkpointEvery === 0) {
          await writeIndex(slug, buildPayload(slug, images.length, results));
        }
      }

      await writeIndex(slug, buildPayload(slug, images.length, results));
      job.status = "done";
      logger.log(
        `[face] index built for ${slug}: ${images.length} images, ${detected} faces, ${reused} reused, ${failures} failures.`
      );
      if (firstError) logger.error(`[face] first indexing error for ${slug}: ${firstError.message}`);
    } catch (error) {
      job.status = "error";
      job.error = error.message;
      logger.error(`[face] index build failed for ${slug}: ${error.message}`);
    }
  }

  function buildPayload(slug, total, images) {
    return { signature: signatureFor(slug), total, updatedAt: Date.now(), images };
  }

  /**
   * Queues a background build so only one gallery is indexed at a time (bounds
   * memory on shared hosting). Skips galleries that are already fresh unless forced.
   */
  function enqueueBuild(slug, { force = false } = {}) {
    if (queued.has(slug) || jobs.get(slug)?.status === "running") return;
    if (!force && !isStale(slug)) return;
    queued.add(slug);
    buildQueue.push({ slug, force });
    void drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (buildQueue.length) {
        const next = buildQueue.shift();
        queued.delete(next.slug);
        await build(next.slug, { force: next.force });
      }
    } finally {
      draining = false;
    }
  }

  /** Backwards-compatible alias: starts a background build only when one is needed. */
  function ensureBuilt(slug) {
    enqueueBuild(slug);
  }

  function search(slug, descriptor, { threshold, limit = 500 }) {
    const index = readIndex(slug);
    if (!index) return null;

    const matches = [];
    for (const entry of index.images) {
      let best = Infinity;
      for (const face of entry.faces) {
        const value = engine.distance(descriptor, face);
        if (value < best) best = value;
      }
      if (best <= threshold) matches.push({ id: entry.id, scene: entry.scene, distance: best });
    }

    matches.sort((a, b) => a.distance - b.distance);
    return matches.slice(0, limit);
  }

  return { status, build, ensureBuilt, enqueueBuild, search, readIndex, isStale };
}

module.exports = { createFaceIndex };
