"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const { loadEnvFile, readString, readNumber, readBoolean } = require("./lib/env");
const { createConfigStore, createAccessCodes, getAccessCode, setAccessCode, matchAccessCode, toSlug, sourceSignature } = require("./lib/config-store");
const { createSpaceByteClient } = require("./lib/spacebyte-client");
const { createGalleryCache } = require("./lib/gallery-cache");
const { createSyncWorker } = require("./lib/sync-worker");
const { createSessionManager, timingSafeEqual } = require("./lib/session");
const { ZipWriter } = require("./lib/zip-writer");
const imageProcessor = require("./lib/image-processor");
const { sendJson, serveStatic, readJsonBody, SECURITY_HEADERS } = require("./lib/http-utils");

const rootDir = __dirname;
const env = { ...loadEnvFile(path.join(rootDir, ".env")), ...process.env };

// An empty PORT coerces to 0, so only accept a real listening port here.
const port = readNumber(env, "PORT", 0) || 3001;
const host = readString(env, "HOST", "0.0.0.0");
const basePath = normalizeBasePath(readString(env, "APP_BASE_PATH"));
const dataDir = path.resolve(rootDir, readString(env, "DATA_DIR", "./data"));
const adminToken = readString(env, "ADMIN_TOKEN");
const thumbnailSize = readNumber(env, "THUMBNAIL_SIZE", 400);
const previewSize = readNumber(env, "PREVIEW_SIZE", 1600);
const zipPartMaxFiles = readNumber(env, "ZIP_PART_MAX_FILES", 400);
const zipPartMaxBytes = readNumber(env, "ZIP_PART_MAX_BYTES", 1_610_612_736);
const maxPageSize = 120;

const config = createConfigStore(path.join(rootDir, "config", "galleries.json"));
const cache = createGalleryCache(dataDir);
const client = createSpaceByteClient({
  baseUrl: readString(env, "SPACEBYTE_BASE_URL", "https://spacebyte.in/api/v1"),
  token: readString(env, "SPACEBYTE_TOKEN"),
  authScheme: readString(env, "SPACEBYTE_AUTH_SCHEME", "Bearer"),
  allowInsecureTls: readBoolean(env, "SPACEBYTE_ALLOW_INSECURE_TLS", false)
});
const sync = createSyncWorker({
  config,
  cache,
  client,
  thumbnailSize,
  concurrency: readNumber(env, "SYNC_CONCURRENCY", 2),
  refreshMinutes: readNumber(env, "SYNC_REFRESH_MINUTES", 360)
});
const sessions = createSessionManager({
  secret: resolveSessionSecret(),
  ttlHours: readNumber(env, "SESSION_TTL_HOURS", 12),
  basePath,
  secureCookies: readBoolean(env, "SECURE_COOKIES", true)
});

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`Starz Shots Gallery listening on ${host}:${port} (base path '${basePath || "/"}')`);
  if (!imageProcessor.isAvailable()) {
    console.warn("sharp is not installed. Thumbnails will fall back to full-resolution originals until 'npm install' provides it.");
  }
  sync.start();
});

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = stripBasePath(url.pathname);
  const segments = pathname.split("/").filter(Boolean);

  if (request.method === "GET" && pathname === "/healthz") {
    return sendJson(response, 200, { ok: true });
  }

  if (segments[0] === "api") {
    if (segments[1] === "admin") return routeAdmin(request, response, segments.slice(2), url);
    if (segments[1] === "galleries") return routeGallery(request, response, segments.slice(2), url);
    return sendJson(response, 404, { error: "Not found." });
  }

  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  if (pathname === "/admin" || pathname === "/admin/") return serveStatic(rootDir, "/admin.html", response);
  return serveStatic(rootDir, pathname, response);
}

// ---------------------------------------------------------------------------
// Viewer-facing gallery API
// ---------------------------------------------------------------------------

async function routeGallery(request, response, segments, url) {
  const slug = decodeURIComponent(segments[0] || "");
  const action = segments[1] || "";
  const gallery = config.find(slug);
  if (!gallery) return sendJson(response, 404, { error: "Gallery not found." });

  if (request.method === "GET" && action === "meta") {
    return sendJson(response, 200, {
      slug: gallery.slug,
      eventName: gallery.eventName,
      eventDate: gallery.eventDate || "",
      clientName: gallery.clientName || ""
    });
  }

  if (request.method === "POST" && action === "access") {
    return handleAccess(request, response, gallery);
  }

  const session = sessions.read(request, slug);
  if (!session) return sendJson(response, 401, { error: "Enter your access code to view this gallery." });

  if (request.method === "GET" && action === "summary") return handleSummary(response, gallery, session);
  if (request.method === "GET" && action === "images") return handleImages(response, gallery, url);
  if (request.method === "POST" && action === "images-by-id") return handleImagesById(request, response, gallery);
  if (request.method === "GET" && action === "thumbs") return handleDerivative(response, gallery, decodeURIComponent(segments[2] || ""), "thumb");
  if (request.method === "GET" && action === "previews") return handleDerivative(response, gallery, decodeURIComponent(segments[2] || ""), "preview");

  if (request.method === "GET" && action === "files") {
    if (!session.permissions?.canDownloadSingle) return sendJson(response, 403, { error: "Downloads are not enabled for this access code." });
    return handleOriginal(response, gallery, decodeURIComponent(segments[2] || ""));
  }

  if (request.method === "GET" && (action === "download-parts" || action === "download-all")) {
    if (!session.permissions?.canDownloadAll) return sendJson(response, 403, { error: "Bulk download is not enabled for this access code." });
    return action === "download-parts" ? handleDownloadParts(response, gallery) : handleDownloadAll(response, gallery, url);
  }

  return sendJson(response, 404, { error: "Not found." });
}

async function handleAccess(request, response, gallery) {
  const body = await readJsonBody(request);
  const viewerId = String(body.viewerId || "").trim();
  const access = matchAccessCode(gallery, body.accessCode);

  if (!viewerId || !access) return sendJson(response, 401, { error: "Invalid access code." });

  const permissions = access.permissions || { canFavorite: true, canDownloadSingle: true, canDownloadAll: false };
  const cookie = sessions.cookieHeader({ slug: gallery.slug, role: access.role, viewerId, permissions });

  return sendJson(response, 200, { role: access.role, viewerId, label: access.label, permissions }, { "Set-Cookie": cookie });
}

function handleSummary(response, gallery, session) {
  const index = cache.readIndex(gallery.slug);
  const state = sync.status(gallery.slug);
  const scenes = (index?.scenes || []).map((scene) => ({ name: scene.name, count: scene.count }));
  const firstImage = index?.scenes?.length ? cache.readScene(gallery.slug, index.scenes[0].number)[0] : null;

  return sendJson(response, 200, {
    slug: gallery.slug,
    eventName: gallery.eventName,
    eventDate: gallery.eventDate || "",
    clientName: gallery.clientName || "",
    role: session.role,
    viewerId: session.viewerId,
    permissions: session.permissions,
    coverImage:
      String(gallery.coverImage || "").trim() ||
      (firstImage ? `${basePath}/api/galleries/${encodeURIComponent(gallery.slug)}/previews/${encodeURIComponent(firstImage.id)}` : ""),
    totalImages: index?.totalImages || 0,
    scenes,
    sync: { status: state.status, cachedThumbnails: state.cachedThumbnails || 0, totalImages: state.totalImages || 0 }
  });
}

function handleImages(response, gallery, url) {
  const sceneName = url.searchParams.get("scene") || "all";
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) | 0);
  const limit = Math.min(maxPageSize, Math.max(1, Number(url.searchParams.get("limit") || 60) | 0));
  const result = cache.page(gallery.slug, sceneName, offset, limit);

  return sendJson(response, 200, {
    total: result.total,
    offset,
    limit,
    images: result.images.map((image) => withUrls(gallery.slug, image))
  });
}

async function handleImagesById(request, response, gallery) {
  const body = await readJsonBody(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
  const images = cache.imagesByIds(gallery.slug, ids).map((image) => withUrls(gallery.slug, image));
  return sendJson(response, 200, { images });
}

function withUrls(slug, image) {
  const base = `${basePath}/api/galleries/${encodeURIComponent(slug)}`;
  const fileId = encodeURIComponent(image.id);
  return {
    id: image.id,
    filename: image.filename,
    scene: image.scene,
    sceneIndex: image.sceneIndex,
    thumbnailUrl: `${base}/thumbs/${fileId}`,
    url: `${base}/previews/${fileId}`,
    downloadUrl: `${base}/files/${fileId}`
  };
}

/** Serves the cached derivative when present; otherwise builds it from SpaceByte and caches it for the next viewer. */
async function handleDerivative(response, gallery, fileId, kind) {
  const located = cache.findImage(gallery.slug, fileId);
  if (!located) return sendJson(response, 404, { error: "Photo not found in this gallery." });

  const size = kind === "thumb" ? thumbnailSize : previewSize;
  const targetPath =
    kind === "thumb"
      ? cache.thumbnailPath(gallery.slug, located.scene.dirName, fileId)
      : cache.previewPath(gallery.slug, located.scene.dirName, fileId);

  if (fs.existsSync(targetPath)) return sendCachedFile(response, targetPath);

  const source = await client.streamDownload(fileId);
  if (source.statusCode < 200 || source.statusCode >= 300) {
    source.resume();
    return sendJson(response, 502, { error: `SpaceByte returned status ${source.statusCode}.` });
  }

  try {
    await imageProcessor.writeResized(source, targetPath, size);
  } catch (error) {
    return sendJson(response, 502, { error: `Could not prepare the photo: ${error.message}` });
  }
  return sendCachedFile(response, targetPath);
}

function sendCachedFile(response, filePath) {
  const stats = fs.statSync(filePath);
  response.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": stats.size,
    "Cache-Control": "private, max-age=604800",
    ETag: `"${stats.size}-${Number(stats.mtimeMs).toString(16)}"`,
    ...SECURITY_HEADERS
  });
  return pipeline(fs.createReadStream(filePath), response);
}

async function handleOriginal(response, gallery, fileId) {
  const located = cache.findImage(gallery.slug, fileId);
  if (!located) return sendJson(response, 404, { error: "Photo not found in this gallery." });

  const upstream = await client.streamDownload(fileId);
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    upstream.resume();
    return sendJson(response, 502, { error: `SpaceByte download failed with status ${upstream.statusCode}.` });
  }

  response.writeHead(200, {
    "Content-Type": upstream.headers["content-type"] || "application/octet-stream",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `attachment; filename="${located.image.filename.replace(/["\\]/g, "_")}"`,
    ...SECURITY_HEADERS
  });
  return pipeline(upstream, response);
}

function buildDownloadParts(slug) {
  const parts = [];
  let current = { images: [], bytes: 0 };

  for (const image of cache.allImages(slug)) {
    if (current.images.length >= zipPartMaxFiles || (current.bytes + image.size > zipPartMaxBytes && current.images.length)) {
      parts.push(current);
      current = { images: [], bytes: 0 };
    }
    current.images.push(image);
    current.bytes += image.size;
  }

  if (current.images.length) parts.push(current);
  return parts;
}

function handleDownloadParts(response, gallery) {
  const parts = buildDownloadParts(gallery.slug);
  return sendJson(response, 200, {
    parts: parts.map((part, index) => ({
      part: index + 1,
      imageCount: part.images.length,
      approximateBytes: part.bytes,
      url: `${basePath}/api/galleries/${encodeURIComponent(gallery.slug)}/download-all?part=${index + 1}`
    }))
  });
}

async function handleDownloadAll(response, gallery, url) {
  const parts = buildDownloadParts(gallery.slug);
  const partNumber = Math.max(1, Number(url.searchParams.get("part") || 1) | 0);
  const part = parts[partNumber - 1];

  if (!part) return sendJson(response, 404, { error: "No photos are available for that download part." });

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "starzshots-"));
  const suffix = parts.length > 1 ? `-part${partNumber}-of-${parts.length}` : "";

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${gallery.slug}${suffix}.zip"`,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
  });

  const zip = new ZipWriter(response);
  const usedNames = new Set();

  try {
    for (const image of part.images) {
      const stagedPath = path.join(tempDir, "current");
      const upstream = await client.streamDownload(image.id);
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        upstream.resume();
        continue;
      }

      await pipeline(upstream, fs.createWriteStream(stagedPath));
      await zip.addLocalFile(uniqueEntryName(usedNames, `${image.scene}/${image.filename}`), stagedPath);
      await fsp.rm(stagedPath, { force: true });
    }
    await zip.finish();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
    response.end();
  }
}

function uniqueEntryName(usedNames, name) {
  let candidate = name;
  let counter = 2;
  while (usedNames.has(candidate)) {
    const extension = path.extname(name);
    candidate = `${name.slice(0, name.length - extension.length)} (${counter})${extension}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

async function routeAdmin(request, response, segments, url) {
  if (!authorizeAdmin(request, response)) return undefined;

  if (request.method === "GET" && segments[0] === "events" && !segments[1]) {
    return sendJson(response, 200, { events: config.list().map(toAdminEvent) });
  }

  if (request.method === "POST" && segments[0] === "events" && !segments[1]) {
    return handleCreateEvent(request, response);
  }

  if (segments[0] === "events" && segments[1] && segments[2] === "sync") {
    const slug = decodeURIComponent(segments[1]);
    if (!config.find(slug)) return sendJson(response, 404, { error: "Gallery not found." });

    if (request.method === "POST") {
      const body = await readJsonBody(request).catch(() => ({}));
      sync.enqueue(slug, { force: Boolean(body.force) });
      return sendJson(response, 202, { ok: true, sync: sync.status(slug) });
    }
    if (request.method === "GET") return sendJson(response, 200, { sync: sync.status(slug) });
  }

  if (request.method === "PUT" && segments[0] === "events" && segments[1] && !segments[2]) {
    return handleUpdateEvent(request, response, decodeURIComponent(segments[1]));
  }

  if (request.method === "POST" && segments[0] === "browse-spacebyte-folders") {
    return handleBrowseFolders(request, response);
  }

  if (request.method === "GET" && segments[0] === "spacebyte-status") {
    return handleSpaceByteStatus(response);
  }

  return sendJson(response, 404, { error: "Not found." });
}

function authorizeAdmin(request, response) {
  if (!adminToken) {
    sendJson(response, 503, { error: "ADMIN_TOKEN is not configured." });
    return false;
  }
  const provided = String(request.headers["x-admin-token"] || extractBearer(request)).trim();
  if (!timingSafeEqual(provided, adminToken)) {
    sendJson(response, 401, { error: "Invalid admin token." });
    return false;
  }
  return true;
}

function extractBearer(request) {
  const header = String(request.headers.authorization || "").trim();
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function toAdminEvent(gallery) {
  const state = sync.status(gallery.slug);
  return {
    slug: gallery.slug,
    eventName: gallery.eventName,
    eventDate: gallery.eventDate || "",
    clientName: gallery.clientName || "",
    spacebyteRootFolderId: gallery.spacebyteRootFolderId || "",
    spacebyteFolderName: gallery.spacebyteFolderName || "",
    spacebyteFolderPath: gallery.spacebyteFolderPath || "",
    sceneFolderNames: gallery.sceneFolderNames || [],
    coverImage: gallery.coverImage || "",
    clientCode: getAccessCode(gallery, "client"),
    guestCode: getAccessCode(gallery, "guest"),
    sync: { status: state.status, queued: state.queued, cachedThumbnails: state.cachedThumbnails || 0, totalImages: state.totalImages || 0, error: state.error || "" }
  };
}

async function handleCreateEvent(request, response) {
  const body = await readJsonBody(request);
  const eventName = String(body.eventName || "").trim();
  const slug = toSlug(String(body.slug || eventName));
  const clientCode = String(body.clientCode || "").trim();
  const spacebyteRootFolderId = String(body.spacebyteRootFolderId || "").trim();
  const spacebyteFolderName = String(body.spacebyteFolderName || "").trim();
  const spacebyteFolderPath = String(body.spacebyteFolderPath || "").trim();

  if (!eventName || !slug || !clientCode) {
    return sendJson(response, 400, { error: "eventName, slug, and clientCode are required." });
  }
  if (!spacebyteRootFolderId && !spacebyteFolderName && !spacebyteFolderPath) {
    return sendJson(response, 400, { error: "Provide a SpaceByte folder ID, folder name, or folder path." });
  }
  if (config.find(slug)) {
    return sendJson(response, 409, { error: `Event slug '${slug}' already exists.` });
  }

  const gallery = config.add({
    slug,
    eventName,
    eventDate: String(body.eventDate || "").trim(),
    clientName: String(body.clientName || "").trim(),
    spacebyteRootFolderId,
    spacebyteRootFolderHash: String(body.spacebyteRootFolderHash || "").trim(),
    spacebyteFolderName,
    spacebyteFolderPath,
    sceneFolderNames: Array.isArray(body.sceneFolderNames) ? body.sceneFolderNames.map((name) => String(name).trim()).filter(Boolean) : [],
    coverImage: String(body.coverImage || "").trim(),
    accessCodes: createAccessCodes(clientCode, String(body.guestCode || "guest").trim() || "guest")
  });

  sync.enqueue(slug);
  return sendJson(response, 201, { ok: true, event: toAdminEvent(gallery) });
}

async function handleUpdateEvent(request, response, slug) {
  const gallery = config.find(slug);
  if (!gallery) return sendJson(response, 404, { error: "Gallery not found." });

  const body = await readJsonBody(request);
  const before = sourceSignature(gallery);

  for (const field of ["eventName", "eventDate", "clientName", "spacebyteRootFolderId", "spacebyteRootFolderHash", "spacebyteFolderName", "spacebyteFolderPath", "coverImage"]) {
    if (body[field] !== undefined) gallery[field] = String(body[field] || "").trim();
  }
  if (Array.isArray(body.sceneFolderNames)) {
    gallery.sceneFolderNames = body.sceneFolderNames.map((name) => String(name).trim()).filter(Boolean);
  }
  if (body.clientCode !== undefined) setAccessCode(gallery, "client", String(body.clientCode).trim());
  if (body.guestCode !== undefined) setAccessCode(gallery, "guest", String(body.guestCode).trim());

  config.save();
  if (sourceSignature(gallery) !== before) sync.enqueue(slug);

  return sendJson(response, 200, { ok: true, event: toAdminEvent(gallery) });
}

async function handleBrowseFolders(request, response) {
  const body = await readJsonBody(request);
  const searchTerm = String(body.searchTerm || "").trim().toLowerCase();
  const parentId = String(body.parentId || "").trim();

  try {
    const folders = await client.listFolders(parentId);
    const filtered = searchTerm ? folders.filter((folder) => String(folder.name || "").toLowerCase().includes(searchTerm)) : folders.slice(0, 100);
    return sendJson(response, 200, {
      folders: filtered.map((folder) => ({ id: String(folder.id || ""), name: String(folder.name || ""), path: String(folder.path || "") }))
    });
  } catch (error) {
    return sendJson(response, 400, { error: error.message || "Unable to browse SpaceByte folders." });
  }
}

async function handleSpaceByteStatus(response) {
  const configured = {
    baseUrl: readString(env, "SPACEBYTE_BASE_URL", "https://spacebyte.in/api/v1"),
    tokenPresent: Boolean(readString(env, "SPACEBYTE_TOKEN")),
    sharpAvailable: imageProcessor.isAvailable()
  };

  try {
    await client.ping();
    return sendJson(response, 200, { ok: true, configured });
  } catch (error) {
    return sendJson(response, 502, { ok: false, configured, error: error.message });
  }
}

// ---------------------------------------------------------------------------

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function stripBasePath(pathname) {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function resolveSessionSecret() {
  const configured = readString(env, "SESSION_SECRET");
  if (configured) return configured;
  console.warn("SESSION_SECRET is not set. A temporary secret was generated; viewers are signed out on every restart.");
  return crypto.randomBytes(32).toString("hex");
}
