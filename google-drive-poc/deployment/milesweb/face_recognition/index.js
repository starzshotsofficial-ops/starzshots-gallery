"use strict";

/**
 * Self-contained selfie face-matching feature for the Starz Shots Gallery.
 *
 * Wire it into server.js with a few lines (see INTEGRATION.md). It exposes:
 *   GET  /find-my-photos[...]                          the client page + its assets
 *   GET  /api/galleries/:slug/face/status              index readiness / progress
 *   POST /api/galleries/:slug/face/index               (re)build the face index
 *   POST /api/galleries/:slug/face/search              match an uploaded selfie
 *
 * Matches reuse the gallery's existing thumbnail / preview / file endpoints, so
 * downloads still come straight from Google Drive exactly like the main gallery.
 */

const fs = require("fs");
const path = require("path");

const { createFaceEngine } = require("./lib/face-engine");
const { createFaceIndex } = require("./lib/face-index");
const { createSetup } = require("./lib/setup");

function createFaceRecognition({
  cache,
  drive,
  config,
  dataDir,
  basePath,
  port,
  thumbnailSize,
  sendJson,
  readJsonBody,
  SECURITY_HEADERS,
  logger = console,
  options = {}
}) {
  const publicDir = path.join(__dirname, "public");
  const modelsDir = path.join(__dirname, "models");
  const modelFiles = new Set(["blazeface.json", "blazeface.bin", "facemesh.json", "facemesh.bin", "faceres.json", "faceres.bin"]);

  const engine = createFaceEngine({
    // Node's fetch (undici) does not support file:// URLs, so models are served over our
    // own loopback HTTP endpoint instead of read directly off disk or from a public CDN.
    modelBasePath: options.modelBasePath || `http://127.0.0.1:${port}${basePath}/face-models/`,
    wasmPath: options.wasmPath,
    matchThreshold: options.matchThreshold ?? 0.4,
    minFaceSize: options.minFaceSize ?? 34,
    minScore: options.minScore ?? 0.4,
    maxDetected: options.maxDetected ?? 100
  });
  const index = createFaceIndex({ dataDir, cache, drive, engine, thumbnailSize, logger, faceImageSize: options.faceImageSize ?? 2048 });
  const setup = createSetup({
    moduleDir: __dirname,
    modelsDir,
    logger,
    autoInstall: options.autoInstall !== false
  });

  const PAGE_ASSETS = {
    "": ["find-my-photos.html", "text/html; charset=utf-8"],
    "index.html": ["find-my-photos.html", "text/html; charset=utf-8"],
    "app.js": ["find-my-photos.js", "text/javascript; charset=utf-8"],
    "app.css": ["find-my-photos.css", "text/css; charset=utf-8"]
  };

  // Best-effort auto-install of packages + models on first start; no-op once present.
  setup.ensureReady().then((ok) => {
    if (ok) indexAllReady();
  });

  /** Called by the sync worker the moment an event finishes caching its thumbnails. */
  function onSyncComplete(slug) {
    setup.ensureReady().then((ok) => {
      if (ok) index.enqueueBuild(slug);
    });
  }

  /** Pre-warm indexes for every event whose thumbnails are already cached. */
  function indexAllReady() {
    if (!config || typeof config.list !== "function") return;
    for (const gallery of config.list()) {
      index.enqueueBuild(gallery.slug);
    }
  }

  function handlePage(request, response, url) {
    const relative = url.pathname.replace(/^.*\/find-my-photos/, "").replace(/^\/+/, "");
    const asset = PAGE_ASSETS[relative];
    if (!asset) return sendJson(response, 404, { error: "Not found." });

    const file = path.join(publicDir, asset[0]);
    if (!fs.existsSync(file)) return sendJson(response, 404, { error: "Not found." });

    response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    return fs.createReadStream(file).pipe(response);
  }

  /** Serves a downloaded Human model file to the inference worker's fetch() call. */
  function handleModelFile(response, filename) {
    if (!modelFiles.has(filename)) return sendJson(response, 404, { error: "Not found." });

    const file = path.join(modelsDir, filename);
    if (!fs.existsSync(file)) return sendJson(response, 404, { error: "Not found." });

    const contentType = filename.endsWith(".json") ? "application/json" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    return fs.createReadStream(file).pipe(response);
  }

  async function handleGallery(request, response, gallery, session, segments, url) {
    const action = segments[0] || "";
    const slug = gallery.slug;

    if (request.method === "GET" && action === "status") {
      return sendJson(response, 200, { setup: setup.snapshot(), ...index.status(slug) });
    }

    if (request.method === "POST" && action === "index") {
      if (!setup.ready()) return preparing(response, setup.ensureReady);
      index.enqueueBuild(slug, { force: url.searchParams.get("force") === "1" });
      return sendJson(response, 202, index.status(slug));
    }

    if (request.method === "POST" && action === "search") {
      const body = await readJsonBody(request, 12 * 1024 * 1024);
      const buffer = decodeSelfie(body.image);
      if (!buffer) return sendJson(response, 400, { error: "Please choose a clear selfie photo." });

      if (!setup.ready()) return preparing(response, setup.ensureReady);

      const state = index.status(slug);
      if (state.status !== "ready") {
        index.ensureBuilt(slug);
        return sendJson(response, 200, { status: "indexing", progress: index.status(slug) });
      }
      if (index.isStale(slug)) index.ensureBuilt(slug);

      let descriptor;
      try {
        descriptor = await engine.describeLargest(buffer);
      } catch (error) {
        logger.error(`[face] selfie read failed for ${slug}: ${error.message}`);
        return sendJson(response, 422, { error: "That photo could not be read. Try a clear, front-facing selfie." });
      }
      if (!descriptor) return sendJson(response, 200, { status: "no-face" });

      const threshold = clampThreshold(url.searchParams.get("threshold"), engine.matchThreshold);
      const matches = index.search(slug, descriptor, { threshold }) || [];
      const images = matches.map((match) => withUrls(slug, match));
      return sendJson(response, 200, { status: "ready", count: images.length, images });
    }

    return sendJson(response, 404, { error: "Not found." });
  }

  function preparing(response, kickOff) {
    kickOff();
    const snapshot = setup.snapshot();
    if (snapshot.error && snapshot.deps === "error") {
      return sendJson(response, 503, { error: snapshot.error });
    }
    return sendJson(response, 200, { status: "preparing", setup: snapshot });
  }

  function withUrls(slug, match) {
    const base = `${basePath}/api/galleries/${encodeURIComponent(slug)}`;
    const fileId = encodeURIComponent(match.id);
    return {
      id: match.id,
      scene: match.scene,
      distance: Number(match.distance.toFixed(4)),
      thumbnailUrl: `${base}/thumbs/${fileId}`,
      url: `${base}/previews/${fileId}`,
      downloadUrl: `${base}/files/${fileId}`
    };
  }

  return {
    handlePage,
    handleModelFile,
    handleGallery,
    onSyncComplete,
    indexAllReady,
    ready: setup.ready,
    // For the admin "Rebuild face index" button; bypasses the isStale() freshness check.
    rebuildIndex: (slug) => {
      setup.ensureReady().then((ok) => {
        if (ok) index.enqueueBuild(slug, { force: true });
      });
      return index.status(slug);
    },
    indexStatus: (slug) => index.status(slug),
    // Removes a gallery's whole face index (index.json + high-res src cache); call on event delete.
    removeIndex: (slug) => index.remove(slug)
  };
}

function decodeSelfie(value) {
  const match = /^data:image\/jpe?g;base64,([a-z0-9+/=]+)$/i.exec(String(value || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function clampThreshold(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.7, Math.max(0.35, value));
}

module.exports = { createFaceRecognition };
