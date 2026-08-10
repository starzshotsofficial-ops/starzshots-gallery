// Portable, single-event Starz Shots Gallery — event details are hardcoded below,
// but the SpaceByte token is kept out of source (loaded from .env / a real env var).
// Run: node server.js  (or double-click the compiled .exe built with `npm run build`)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

// When packaged with pkg, __dirname points into a read-only virtual snapshot,
// so writable data (favorites) must live next to the actual executable instead.
const assetsDir = __dirname;
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const envPaths = process.pkg
  ? [path.join(assetsDir, ".env"), path.join(baseDir, ".env")]
  : [path.join(assetsDir, ".env")];
const env = { ...loadEnvFromCandidates(envPaths), ...process.env };

const PORT = Number(env.PORT || 8088);

// --- Hardcoded event configuration (copied from config/galleries.json) ---
const SPACEBYTE_BASE_URL = env.SPACEBYTE_BASE_URL || "https://spacebyte.in/api/v1";
const HARDCODED_SPACEBYTE_TOKEN = ""; // Optional: embed token directly here before building
const SPACEBYTE_TOKEN = env.SPACEBYTE_TOKEN || HARDCODED_SPACEBYTE_TOKEN || "";
const SPACEBYTE_AUTH_SCHEME = env.SPACEBYTE_AUTH_SCHEME || "Bearer";
const ALLOW_INSECURE_TLS = String(env.SPACEBYTE_ALLOW_INSECURE_TLS || "true").trim().toLowerCase() === "true";

const GALLERY = {
  slug: "ameya-ayushyahomam",
  eventName: "Ameya Ayushyahomam",
  eventDate: "2026-08-07",
  clientName: "Venkatraman",
  spacebyteFolderPath: "11320800",
  spacebyteRootFolderId: "11320800",
  spacebyteRootFolderHash: "MTEzMjA4MDB8cA",
  spacebyteFolderName: "",
  sceneFolderNames: ["Photos"],
  coverImage: "",
  accessCodes: [
    {
      label: "Client",
      code: "0708",
      role: "client",
      permissions: { canFavorite: true, canDownloadSingle: true, canDownloadAll: true }
    },
    {
      label: "Guest",
      code: "guest",
      role: "guest",
      permissions: { canFavorite: true, canDownloadSingle: true, canDownloadAll: false }
    }
  ]
};
// --- End hardcoded event configuration ---

if (ALLOW_INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const favoritesStorePath = path.join(baseDir, "data", "favorites-submissions.json");
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
let hydratedGallery = null;
let hydrationExpiresAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === `/api/galleries/${GALLERY.slug}/meta`) {
      sendJson(response, 200, buildMeta());
      return;
    }

    if (request.method === "GET" && url.pathname === `/api/galleries/${GALLERY.slug}`) {
      await handleGalleryRequest(response);
      return;
    }

    if (request.method === "GET" && url.pathname === `/api/galleries/${GALLERY.slug}/download-all`) {
      await handleDownloadAll(response);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      await handleFileDownload(url, response);
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
      sendJson(response, 501, { error: "File deletion is not implemented." });
      return;
    }

    if (request.method === "POST" && url.pathname === `/api/galleries/${GALLERY.slug}/favorites/finalize`) {
      await handleFinalizeFavorites(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === `/api/galleries/${GALLERY.slug}/favorites.csv`) {
      await handleFavoritesCsv(response);
      return;
    }

    serveStatic(url.pathname, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  ensureFavoritesStore();
  const url = `http://localhost:${PORT}`;
  console.log(`Starz Shots Gallery (${GALLERY.eventName}) running at ${url}`);
  console.log(`Using SpaceByte base URL: ${SPACEBYTE_BASE_URL}`);
  console.log(`SpaceByte token ${SPACEBYTE_TOKEN ? `loaded (${SPACEBYTE_TOKEN.length} chars)` : "missing"}`);
  if (!SPACEBYTE_TOKEN) {
    console.warn("Warning: SPACEBYTE_TOKEN is not set. Photos will not load.");
  }
  openBrowser(url);
});

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"` : platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function buildMeta() {
  return {
    eventName: GALLERY.eventName,
    eventDate: GALLERY.eventDate,
    clientName: GALLERY.clientName,
    slug: GALLERY.slug,
    accessCodes: GALLERY.accessCodes,
    coverImage: GALLERY.coverImage || ""
  };
}

async function handleGalleryRequest(response) {
  if (hydratedGallery && hydrationExpiresAt > Date.now()) {
    sendJson(response, 200, hydratedGallery);
    return;
  }

  try {
    hydratedGallery = await hydrateGalleryFromSpaceByte();
    hydrationExpiresAt = Date.now() + CACHE_TTL_MS;
    sendJson(response, 200, hydratedGallery);
  } catch (error) {
    sendJson(response, 502, { error: `SpaceByte hydration failed: ${error.message}` });
  }
}

async function hydrateGalleryFromSpaceByte() {
  const childEntries = await spacebyteListAll({ folderId: GALLERY.spacebyteRootFolderId });
  const folderByName = new Map(
    childEntries.filter((entry) => entry.type === "folder").map((entry) => [String(entry.name || "").toLowerCase(), entry])
  );

  const scenes = (
    await Promise.all(
      GALLERY.sceneFolderNames.map(async (sceneName) => {
        const sceneFolder = folderByName.get(String(sceneName || "").toLowerCase());
        if (!sceneFolder) return null;

        const sceneEntries = await spacebyteListAll({ folderId: sceneFolder.id });
        const images = sceneEntries
          .filter((entry) => entry.type === "image" || imageExtensions.has(String(entry.extension || "").toLowerCase()))
          .sort((a, b) => compareFilenamesNatural(a.name, b.name))
          .map((entry) => toGalleryImage(sceneName, entry));

        return { name: sceneName, spacebytePath: sceneFolder.path || "", images };
      })
    )
  ).filter(Boolean);

  const fallbackCover = scenes[0]?.images[0]?.thumbnailUrl || scenes[0]?.images[0]?.url || "";

  return {
    ...GALLERY,
    coverImage: GALLERY.coverImage || fallbackCover,
    apiDownloadAllUrl: `/api/galleries/${GALLERY.slug}/download-all`,
    scenes
  };
}

function compareFilenamesNatural(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

function toGalleryImage(sceneName, entry) {
  const hash = String(entry.hash || "");
  const entryId = String(entry.id || "");
  const filename = String(entry.name || entry.file_name || `image-${entry.id}.jpg`);
  const id = `${toSlug(sceneName)}-${entry.id}`;
  const downloadKey = entryId || hash;

  return {
    id,
    filename,
    spacebyteEntryId: entryId,
    spacebyteHash: hash,
    url: `/api/files/${encodeURIComponent(entryId)}`,
    thumbnailUrl: `/api/files/${encodeURIComponent(entryId)}`,
    downloadUrl: `/api/files/${encodeURIComponent(entryId)}`
  };
}

async function spacebyteListAll(filters) {
  const first = await spacebyteFetchPage(filters, 1);
  const items = Array.isArray(first.data) ? [...first.data] : [];

  let nextPage = first.next_page ? Number(first.next_page) : null;
  const concurrency = 10;

  while (nextPage) {
    const pagesToFetch = Array.from({ length: concurrency }, (_, index) => nextPage + index);
    const batch = await Promise.all(
      pagesToFetch.map((page) => spacebyteFetchPage(filters, page).catch(() => ({ data: [], next_page: null })))
    );

    let highestNextPage = null;
    for (const payload of batch) {
      const pageItems = Array.isArray(payload.data) ? payload.data : [];
      if (!pageItems.length) continue;
      items.push(...pageItems);

      const candidate = payload.next_page ? Number(payload.next_page) : null;
      if (Number.isFinite(candidate) && (highestNextPage === null || candidate > highestNextPage)) {
        highestNextPage = candidate;
      }
    }

    nextPage = highestNextPage;
  }

  return items;
}

function spacebyteFetchPage(filters, page) {
  const params = new URLSearchParams();
  params.set("page", String(page));

  if (filters?.folderId) {
    params.set("folderId", String(filters.folderId));
    params.set("parentId", String(filters.parentId || filters.folderId));
  }
  if (filters?.path) {
    params.set("path", String(filters.path));
  }

  return spacebyteJson(`${SPACEBYTE_BASE_URL}/drive/file-entries?${params.toString()}`);
}

async function spacebyteJson(url) {
  const headers = {
    Authorization: `${SPACEBYTE_AUTH_SCHEME} ${SPACEBYTE_TOKEN}`,
    Accept: "application/json",
    "User-Agent": "StarzShotsGallery/1.0"
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`SpaceByte request failed with status ${response.status}${body ? ` - ${body.slice(0, 240)}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleFileDownload(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const key = decodeURIComponent(parts[2] || "").trim();
  if (!key) {
    sendJson(response, 400, { error: "Missing file key." });
    return;
  }

  const isNumericId = /^[0-9]+$/.test(key);
  let sourceUrl = isNumericId
    ? `${SPACEBYTE_BASE_URL}/file-entries/${encodeURIComponent(key)}/download`
    : `${SPACEBYTE_BASE_URL}/file-entries/download/${encodeURIComponent(key)}`;

  console.log(`File download request for key=${key} numeric=${isNumericId} sourceUrl=${sourceUrl}`);

  let success = await proxySpaceByteDownload(sourceUrl, response, "inline", { sendErrors: false });
  if (!success && !isNumericId) {
    if (!hydratedGallery || hydrationExpiresAt <= Date.now()) {
      try {
        hydratedGallery = await hydrateGalleryFromSpaceByte();
        hydrationExpiresAt = Date.now() + CACHE_TTL_MS;
      } catch (error) {
        console.warn(`Failed to refresh gallery cache for hash fallback: ${error.message}`);
      }
    }

    const entryId = resolveSpaceByteEntryIdByHash(key);
    if (entryId) {
      const retryUrl = `${SPACEBYTE_BASE_URL}/file-entries/${encodeURIComponent(entryId)}/download`;
      console.log(`Retrying SpaceByte image download using entryId=${entryId} retryUrl=${retryUrl}`);
      success = await proxySpaceByteDownload(retryUrl, response, "inline", { sendErrors: false });
    }
  }

  if (!success) {
    await proxySpaceByteDownload(sourceUrl, response, "inline", { sendErrors: true });
  }
}

function resolveSpaceByteEntryIdByHash(hash) {
  if (!hydratedGallery?.scenes?.length) return null;
  for (const scene of hydratedGallery.scenes) {
    for (const image of scene.images) {
      if (image.spacebyteHash === hash || image.spacebyteEntryId === hash) {
        return image.spacebyteEntryId || null;
      }
    }
  }
  return null;
}

async function handleDownloadAll(response) {
  await proxySpaceByteDownload(
    `${SPACEBYTE_BASE_URL}/file-entries/download/${encodeURIComponent(GALLERY.spacebyteRootFolderHash)}`,
    response,
    `attachment; filename="${GALLERY.slug}.zip"`
  );
}

async function proxySpaceByteDownload(sourceUrl, response, defaultDisposition, options = {}) {
  const requestHeaders = {
    Authorization: `${SPACEBYTE_AUTH_SCHEME} ${SPACEBYTE_TOKEN}`,
    Accept: "*/*",
    "User-Agent": "StarzShotsGallery/1.0"
  };
  let upstream;

  try {
    upstream = await fetch(sourceUrl, { headers: requestHeaders });
  } catch (error) {
    console.error(`Proxy fetch error: ${sourceUrl} => ${error.message}`);
    if (options.sendErrors !== false) {
      sendJson(response, 502, { error: "SpaceByte proxy request failed." });
    }
    return false;
  }

  if (!upstream.ok || !upstream.body) {
    const bodyText = await upstream.text().catch(() => "");
    console.error(`Proxy failed: ${sourceUrl} => ${upstream.status} ${bodyText}`);
    if (options.sendErrors !== false) {
      sendJson(response, upstream.status || 502, { error: `SpaceByte download failed with status ${upstream.status}.` });
    }
    return false;
  }

  const responseHeaders = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": upstream.headers.get("content-disposition") || defaultDisposition
  };

  try {
    const body = await upstream.arrayBuffer();
    const buffer = Buffer.from(body);
    if (!responseHeaders["Content-Length"]) {
      responseHeaders["Content-Length"] = String(buffer.length);
    }
    response.writeHead(200, responseHeaders);
    response.end(buffer);
    return true;
  } catch (error) {
    console.error(`Download proxy failed for ${sourceUrl}:`, error.message);
    if (!response.headersSent && options.sendErrors !== false) {
      sendJson(response, 502, { error: "Failed to proxy SpaceByte file download." });
    } else {
      response.destroy();
    }
    return false;
  }
}

async function handleFinalizeFavorites(request, response) {
  const body = await readJsonBody(request);
  const viewerId = normalizeViewerId(body.viewerId || "");
  const accessCode = String(body.accessCode || "").trim();
  const access = resolveAccess(viewerId, accessCode);

  if (!access) {
    sendJson(response, 403, { error: "Invalid access code." });
    return;
  }

  const favorites = Array.isArray(body.favorites) ? body.favorites : [];
  if (!favorites.length) {
    sendJson(response, 400, { error: "No favorites selected." });
    return;
  }

  const store = readFavoritesStore();
  const submissionId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  store.submissions.push({
    submissionId,
    slug: GALLERY.slug,
    eventName: GALLERY.eventName,
    viewerId,
    viewerLabel: String(body.viewerLabel || viewerId),
    role: access.role,
    submittedAt: new Date().toISOString(),
    favorites: favorites.map((favorite) => ({
      scene: favorite.scene || "",
      sceneIndex: Number(favorite.sceneIndex) || 0,
      filename: String(favorite.filename || ""),
      spacebyteEntryId: String(favorite.spacebyteEntryId || ""),
      spacebyteHash: String(favorite.spacebyteHash || "")
    }))
  });

  fs.writeFileSync(favoritesStorePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  sendJson(response, 201, { ok: true, submissionId, favorites: favorites.length });
}

async function handleFavoritesCsv(response) {
  const store = readFavoritesStore();
  const submissions = store.submissions.filter((entry) => entry.slug === GALLERY.slug);
  const rows = [];

  submissions.forEach((submission) => {
    submission.favorites.forEach((favorite) => {
      rows.push({
        submissionId: submission.submissionId,
        submittedAt: submission.submittedAt,
        viewerId: submission.viewerId,
        viewerLabel: submission.viewerLabel,
        role: submission.role,
        scene: favorite.scene,
        sceneIndex: favorite.sceneIndex,
        filename: favorite.filename,
        spacebyteEntryId: favorite.spacebyteEntryId,
        spacebyteHash: favorite.spacebyteHash
      });
    });
  });

  const header = ["submissionId", "submittedAt", "viewerId", "viewerLabel", "role", "scene", "sceneIndex", "filename", "spacebyteEntryId", "spacebyteHash"];
  const csv = [header.join(",")]
    .concat(rows.map((row) => header.map((key) => JSON.stringify(row[key] || "")).join(",")))
    .join("\n");

  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${GALLERY.slug}-favorites.csv"`
  });
  response.end(csv);
}

function resolveAccess(viewerId, accessCode) {
  const normalizedCode = String(accessCode || "").trim().toLowerCase();
  return GALLERY.accessCodes.find((entry) => String(entry.code || "").trim().toLowerCase() === normalizedCode) || null;
}

function normalizeViewerId(value) {
  return String(value || "").trim().toLowerCase();
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureFavoritesStore() {
  fs.mkdirSync(path.dirname(favoritesStorePath), { recursive: true });
  if (!fs.existsSync(favoritesStorePath)) {
    fs.writeFileSync(favoritesStorePath, JSON.stringify({ submissions: [] }, null, 2) + "\n", "utf8");
  }
}

function readFavoritesStore() {
  try {
    return JSON.parse(fs.readFileSync(favoritesStorePath, "utf8"));
  } catch {
    return { submissions: [] };
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk.toString()));
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function serveStatic(urlPath, response) {
  const normalized = decodeURIComponent(urlPath.split("?")[0] || "/");
  const filePath = normalized === "/" ? path.join(assetsDir, "index.html") : path.join(assetsDir, normalized.slice(1));

  if (!filePath.startsWith(assetsDir)) {
    sendJson(response, 400, { error: "Invalid path." });
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  response.end(fs.readFileSync(filePath));
}

function loadEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const result = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function loadEnvFromCandidates(paths) {
  for (const candidate of paths) {
    const env = loadEnv(candidate);
    if (Object.keys(env).length > 0) {
      return env;
    }
  }
  return {};
}
