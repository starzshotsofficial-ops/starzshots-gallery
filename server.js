const http = require("http");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const rootDir = __dirname;
const port = Number(process.env.PORT || 8080);
// Merge .env (local dev) with process.env, which takes precedence (Render/host-provided vars)
const env = { ...loadEnv(path.join(rootDir, ".env")), ...process.env };
const galleriesConfigPath = path.join(rootDir, "config", "galleries.json");
const config = readJson(galleriesConfigPath) || { galleries: [] };
const favoritesStorePath = path.join(rootDir, "data", "favorites-submissions.json");

const spacebyteBaseUrl = env.SPACEBYTE_BASE_URL || "https://spacebyte.in/api/v1";
const spacebyteToken = env.SPACEBYTE_TOKEN || "";
const spacebyteAuthScheme = String(env.SPACEBYTE_AUTH_SCHEME || "Bearer").trim() || "Bearer";
const adminToken = env.ADMIN_TOKEN || "";
const allowInsecureTls = String(env.SPACEBYTE_ALLOW_INSECURE_TLS || "").trim().toLowerCase() === "true";
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const galleryHydrationCache = new Map();
const galleryCacheTtlMs = 10 * 60 * 1000;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
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

    if (request.method === "GET" && url.pathname === "/api/admin/events") {
      if (!authorizeAdmin(request, response)) return;
      const syncWithSpaceByte = url.searchParams.get("sync") === "true";

      if (syncWithSpaceByte) {
        await reconcileGalleriesWithSpaceByte();
      }

      sendJson(response, 200, {
        events: config.galleries.map((gallery) => ({
          slug: gallery.slug,
          eventName: gallery.eventName,
          eventDate: gallery.eventDate,
          clientName: gallery.clientName,
          coverImage: gallery.coverImage || "",
          spacebyteRootFolderId: gallery.spacebyteRootFolderId || "",
          spacebyteFolderPath: gallery.spacebyteFolderPath || "",
          spacebyteFolderName: gallery.spacebyteFolderName || "",
          sceneFolderNames: gallery.sceneFolderNames || [],
          clientCode: getAccessCode(gallery, "client"),
          guestCode: getAccessCode(gallery, "guest"),
          allowedViewers: getAllowedViewerSummary(gallery)
        }))
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/spacebyte-status") {
      if (!authorizeAdmin(request, response)) return;
      await handleSpaceByteStatus(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/events") {
      if (!authorizeAdmin(request, response)) return;
      await handleCreateAdminEvent(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/browse-spacebyte-folders") {
      if (!authorizeAdmin(request, response)) return;
      await handleBrowseSpaceByteFolders(request, response);
      return;
    }

    if (request.method === "PUT" && /^\/api\/admin\/events\/[^/]+$/.test(url.pathname)) {
      if (!authorizeAdmin(request, response)) return;
      await handleUpdateAdminEvent(url, request, response);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      serveStatic("/admin.html", response);
      return;
    }

    if (request.method === "POST" && /\/api\/galleries\/[^/]+\/favorites\/finalize$/.test(url.pathname)) {
      await handleFinalizeFavoritesRequest(request, url, response);
      return;
    }

    if (request.method === "GET" && /\/api\/galleries\/[^/]+\/favorites\.csv$/.test(url.pathname)) {
      await handleFavoritesCsvRequest(url, response);
      return;
    }

    if (request.method === "GET" && /\/api\/galleries\/[^/]+\/download-all$/.test(url.pathname)) {
      await handleDownloadAllRequest(url, response);
      return;
    }

    if (request.method === "DELETE" && /^\/api\/files\/[^/]+$/.test(url.pathname)) {
      await handleDeleteFileRequest(request, url, response);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/galleries/")) {
      await handleGalleryRequest(url, response);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      await handleFileDownload(url, response);
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

server.listen(port, () => {
  ensureFavoritesStore();
  console.log(`Starz Shots Gallery running at http://localhost:${port}`);
});

async function handleCreateAdminEvent(request, response) {
  const body = await readJsonBody(request);
  const eventName = String(body.eventName || "").trim();
  const eventDate = String(body.eventDate || "").trim();
  const clientName = String(body.clientName || "").trim();
  const slug = toSlug(String(body.slug || eventName || "").trim());
  const spacebyteRootFolderId = String(body.spacebyteRootFolderId || "").trim();
  const spacebyteFolderPath = String(body.spacebyteFolderPath || "").trim();
  const coverImage = String(body.coverImage || "").trim();
  const clientCode = String(body.clientCode || "").trim();
  const guestCode = String(body.guestCode || "guest").trim();
  const allowedViewers = Array.isArray(body.allowedViewers) ? body.allowedViewers : [];

  if (!eventName || !eventDate || !clientName || !slug || !clientCode) {
    sendJson(response, 400, {
      error: "eventName, eventDate, clientName, slug, and clientCode are required."
    });
    return;
  }

  if (!spacebyteRootFolderId && !spacebyteFolderPath) {
    sendJson(response, 400, {
      error: "Provide either spacebyteRootFolderId or spacebyteFolderPath."
    });
    return;
  }

  if (config.galleries.some((gallery) => String(gallery.slug || "").toLowerCase() === slug.toLowerCase())) {
    sendJson(response, 409, { error: `Event slug '${slug}' already exists.` });
    return;
  }

  const normalizedAllowedViewers = allowedViewers
    .map((viewer) => ({
      name: String(viewer.name || "").trim(),
      identifiers: Array.isArray(viewer.identifiers)
        ? viewer.identifiers.map((identifier) => String(identifier || "").trim()).filter(Boolean)
        : []
    }))
    .filter((viewer) => viewer.name && viewer.identifiers.length);

  const newGallery = {
    slug,
    eventName,
    eventDate,
    clientName,
    spacebyteFolderPath,
    spacebyteRootFolderId,
    coverImage,
    accessCodes: [
      {
        label: "Client",
        code: clientCode,
        role: "client",
        ...(normalizedAllowedViewers.length ? { allowedViewers: normalizedAllowedViewers } : {}),
        permissions: {
          canFavorite: true,
          canDownloadSingle: true,
          canDownloadAll: true
        }
      },
      {
        label: "Guest",
        code: guestCode,
        role: "guest",
        permissions: {
          canFavorite: true,
          canDownloadSingle: true,
          canDownloadAll: false
        }
      }
    ]
  };

  config.galleries.push(newGallery);
  writeGalleriesConfig(config);

  sendJson(response, 201, {
    ok: true,
    event: {
      slug: newGallery.slug,
      eventName: newGallery.eventName,
      eventDate: newGallery.eventDate,
      clientName: newGallery.clientName
    }
  });
}

async function handleBrowseSpaceByteFolders(request, response) {
  const body = await readJsonBody(request);
  const searchTerm = String(body.searchTerm || "").trim().toLowerCase();
  const parentId = String(body.parentId || "").trim();

  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured in .env." });
    return;
  }

  try {
    const entries = await spacebyteListAll(parentId ? { folderId: parentId } : {});
    const folders = entries.filter((entry) => entry.type === "folder");
    const filtered = searchTerm
      ? folders.filter((folder) => String(folder.name || "").toLowerCase().includes(searchTerm))
      : folders.slice(0, 30);

    sendJson(response, 200, {
      folders: filtered.map((folder) => ({
        id: String(folder.id || ""),
        name: String(folder.name || ""),
        path: String(folder.path || "")
      }))
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error.message || "Unable to browse SpaceByte folders."
    });
  }
}

async function handleUpdateAdminEvent(url, request, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[3] || "");
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const body = await readJsonBody(request);

  if (body.eventName !== undefined) gallery.eventName = String(body.eventName).trim();
  if (body.eventDate !== undefined) gallery.eventDate = String(body.eventDate).trim();
  if (body.clientName !== undefined) gallery.clientName = String(body.clientName).trim();
  if (body.coverImage !== undefined) gallery.coverImage = String(body.coverImage).trim();
  if (body.spacebyteRootFolderId !== undefined) {
    gallery.spacebyteRootFolderId = String(body.spacebyteRootFolderId).trim();
  }
  if (body.spacebyteFolderPath !== undefined) {
    gallery.spacebyteFolderPath = String(body.spacebyteFolderPath).trim();
  }
  if (body.spacebyteFolderName !== undefined) {
    gallery.spacebyteFolderName = String(body.spacebyteFolderName).trim();
  }
  if (Array.isArray(body.sceneFolderNames)) {
    const sceneFolderNames = body.sceneFolderNames.map((name) => String(name || "").trim()).filter(Boolean);
    if (sceneFolderNames.length) {
      gallery.sceneFolderNames = sceneFolderNames;
    }
  }

  if (body.clientCode !== undefined) {
    const clientCode = String(body.clientCode).trim();
    if (!clientCode) {
      sendJson(response, 400, { error: "clientCode cannot be empty." });
      return;
    }
    setAccessCode(gallery, "client", clientCode);
  }

  if (body.guestCode !== undefined) {
    const guestCode = String(body.guestCode).trim();
    if (!guestCode) {
      sendJson(response, 400, { error: "guestCode cannot be empty." });
      return;
    }
    setAccessCode(gallery, "guest", guestCode);
  }

  writeGalleriesConfig(config);
  invalidateHydratedGalleryCache(gallery.slug);

  sendJson(response, 200, {
    ok: true,
    event: {
      slug: gallery.slug,
      eventName: gallery.eventName,
      eventDate: gallery.eventDate,
      clientName: gallery.clientName,
      clientCode: getAccessCode(gallery, "client"),
      guestCode: getAccessCode(gallery, "guest")
    }
  });
}

function setAccessCode(gallery, role, code) {
  gallery.accessCodes = gallery.accessCodes || [];
  const access = gallery.accessCodes.find((entry) => entry.role === role);

  if (access) {
    access.code = code;
    return;
  }

  gallery.accessCodes.push({
    label: role === "client" ? "Client" : "Guest",
    code,
    role,
    permissions: {
      canFavorite: true,
      canDownloadSingle: true,
      canDownloadAll: role === "client"
    }
  });
}

function authorizeAdmin(request, response) {
  if (!adminToken) {
    sendJson(response, 503, { error: "ADMIN_TOKEN is not configured in .env." });
    return false;
  }

  const provided = getAdminTokenFromRequest(request);
  if (provided !== adminToken) {
    sendJson(response, 401, { error: "Invalid admin token." });
    return false;
  }

  return true;
}

function getAdminTokenFromRequest(request) {
  const directHeader = String(request.headers["x-admin-token"] || "").trim();
  if (directHeader) return directHeader;

  const authHeader = String(request.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

function writeGalleriesConfig(payload) {
  fs.writeFileSync(galleriesConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeViewerId(value) {
  return String(value || "").trim().toLowerCase();
}

function getAccessCode(gallery, role) {
  const access = (gallery.accessCodes || []).find((entry) => entry.role === role);
  return access?.code || "";
}

function getAllowedViewerSummary(gallery) {
  const clientAccess = (gallery.accessCodes || []).find((entry) => entry.role === "client");
  if (!clientAccess?.allowedViewers?.length) {
    return "";
  }

  return clientAccess.allowedViewers
    .map((viewer) => {
      const ids = Array.isArray(viewer.identifiers) ? viewer.identifiers.join(", ") : "";
      return `${viewer.name || "Viewer"}: ${ids}`;
    })
    .join(" | ");
}

async function reconcileGalleriesWithSpaceByte() {
  if (!spacebyteToken) return;

  const activeGalleries = [];

  for (const gallery of config.galleries) {
    const exists = await checkGalleryExistsInSpaceByte(gallery);
    if (exists) {
      activeGalleries.push(gallery);
    }
  }

  if (activeGalleries.length !== config.galleries.length) {
    config.galleries.splice(0, config.galleries.length, ...activeGalleries);
    writeGalleriesConfig(config);
  }
}

async function checkGalleryExistsInSpaceByte(gallery) {
  const params = new URLSearchParams();

  if (gallery.spacebyteRootFolderId) {
    params.set("folderId", gallery.spacebyteRootFolderId);
    params.set("parentId", gallery.spacebyteRootFolderId);
  }

  if (gallery.spacebyteFolderPath) {
    params.set("path", gallery.spacebyteFolderPath);
  }

  const url = `${spacebyteBaseUrl}/drive/file-entries${params.toString() ? `?${params}` : ""}`;

  try {
    await spacebyteJson(url);
    return true;
  } catch {
    return false;
  }
}

async function handleSpaceByteStatus(response) {
  const diagnostics = {
    configured: {
      baseUrl: spacebyteBaseUrl,
      authScheme: spacebyteAuthScheme,
      tokenPresent: Boolean(spacebyteToken),
      allowInsecureTls
    },
    timestamp: new Date().toISOString(),
    checks: []
  };

  if (!spacebyteToken) {
    sendJson(response, 503, {
      ...diagnostics,
      ok: false,
      error: "SPACEBYTE_TOKEN is not configured."
    });
    return;
  }

  diagnostics.checks.push(await runSpaceByteCheck("api", `${spacebyteBaseUrl}/drive/file-entries?page=1`));

  for (const gallery of config.galleries || []) {
    if (!hasSpaceByteSource(gallery)) {
      diagnostics.checks.push({
        type: "gallery",
        slug: gallery.slug,
        ok: false,
        skipped: true,
        reason: "No SpaceByte folder source configured"
      });
      continue;
    }

    const check = await runSpaceByteGalleryCheck(gallery);
    diagnostics.checks.push(check);
  }

  const ok = diagnostics.checks.every((check) => check.ok || check.skipped);
  sendJson(response, ok ? 200 : 502, { ...diagnostics, ok });
}

async function runSpaceByteGalleryCheck(gallery) {
  const params = new URLSearchParams();
  if (gallery.spacebyteRootFolderId) {
    params.set("folderId", String(gallery.spacebyteRootFolderId));
    params.set("parentId", String(gallery.spacebyteRootFolderId));
  }
  if (gallery.spacebyteFolderPath) {
    params.set("path", String(gallery.spacebyteFolderPath));
  }

  const url = `${spacebyteBaseUrl}/drive/file-entries${params.toString() ? `?${params}` : ""}`;
  const result = await runSpaceByteCheck("gallery", url);
  return {
    ...result,
    slug: gallery.slug,
    eventName: gallery.eventName,
    rootFolderId: String(gallery.spacebyteRootFolderId || ""),
    folderPath: String(gallery.spacebyteFolderPath || ""),
    folderName: String(gallery.spacebyteFolderName || "")
  };
}

async function runSpaceByteCheck(type, url) {
  try {
    const payload = await spacebyteJson(url);
    const count = Array.isArray(payload?.data) ? payload.data.length : null;
    return {
      type,
      ok: true,
      count,
      request: sanitizeSpaceByteUrl(url)
    };
  } catch (error) {
    return {
      type,
      ok: false,
      error: String(error?.message || "Unknown SpaceByte error"),
      request: sanitizeSpaceByteUrl(url)
    };
  }
}

function sanitizeSpaceByteUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

async function handleFinalizeFavoritesRequest(request, url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[2] || "");
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const body = await readJsonBody(request);
  const viewerId = normalizeViewerId(body.viewerId || "");
  const accessCode = String(body.accessCode || "").trim();
  const access = resolveAccess(gallery, viewerId, accessCode);

  if (!access || access.role !== "guest") {
    sendJson(response, 403, { error: "Only guests can finalize favorites from this action." });
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
    slug,
    eventName: gallery.eventName,
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

  sendJson(response, 201, {
    ok: true,
    submissionId,
    slug,
    favorites: store.submissions[store.submissions.length - 1].favorites.length
  });
}

async function handleFavoritesCsvRequest(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[2] || "");
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const store = readFavoritesStore();
  const submissions = store.submissions.filter((entry) => entry.slug === slug);
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

  const header = [
    "submissionId",
    "submittedAt",
    "viewerId",
    "viewerLabel",
    "role",
    "scene",
    "sceneIndex",
    "filename",
    "spacebyteEntryId",
    "spacebyteHash"
  ];

  const csv = [header.join(",")].concat(
    rows.map((row) =>
      header.map((key) => JSON.stringify(row[key] || "")).join(",")
    )
  ).join("\n");

  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${slug}-favorites.csv"`
  });
  response.end(csv);
}

async function handleDeleteFileRequest(request, url, response) {
  sendJson(response, 501, { error: "File deletion is not implemented." });
}

async function handleGalleryRequest(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[2] || "");
  let gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  if (url.pathname.endsWith("/meta")) {
    sendJson(response, 200, buildMetaFromGallery(gallery));
    return;
  }

  if (spacebyteToken && hasSpaceByteSource(gallery)) {
    const cached = getCachedHydratedGallery(slug);
    if (cached) {
      gallery = cached;
    } else {
      try {
        gallery = await hydrateGalleryFromSpaceByte(gallery);
        setCachedHydratedGallery(slug, gallery);
      } catch (error) {
        console.error(`SpaceByte hydration failed for '${slug}': ${error.message}`);
      }
    }
  }

  sendJson(response, 200, gallery);
}

async function handleFileDownload(url, response) {
  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured." });
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const hash = decodeURIComponent(parts[2] || "").trim();
  if (!hash) {
    sendJson(response, 400, { error: "Missing file hash." });
    return;
  }

  await proxySpaceByteDownload(
    `${spacebyteBaseUrl}/file-entries/download/${encodeURIComponent(hash)}`,
    response,
    "inline"
  );
}

async function handleDownloadAllRequest(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[2] || "");
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured." });
    return;
  }

  const folderHash = String(gallery.spacebyteRootFolderHash || "").trim();
  if (!folderHash) {
    sendJson(response, 400, { error: "spacebyteRootFolderHash is missing for this gallery." });
    return;
  }

  await proxySpaceByteDownload(
    `${spacebyteBaseUrl}/file-entries/download/${encodeURIComponent(folderHash)}`,
    response,
    `attachment; filename="${slug}.zip"`
  );
}

async function proxySpaceByteDownload(sourceUrl, response, defaultDisposition) {
  const upstream = await fetch(sourceUrl, {
    headers: { Authorization: `${spacebyteAuthScheme} ${spacebyteToken}` }
  });

  if (!upstream.ok || !upstream.body) {
    sendJson(response, upstream.status || 502, { error: `SpaceByte download failed with status ${upstream.status}.` });
    return;
  }

  const headers = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": upstream.headers.get("content-disposition") || defaultDisposition
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers["Content-Length"] = contentLength;
  }

  response.writeHead(200, headers);

  try {
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error("Download stream failed:", error.message);
    }
  }
}

function resolveAccess(gallery, viewerId, accessCode) {
  const normalizedViewerId = normalizeViewerId(String(viewerId || ""));
  const normalizedCode = String(accessCode || "").trim().toLowerCase();
  const access = (gallery.accessCodes || []).find((entry) =>
    String(entry.code || "").trim().toLowerCase() === normalizedCode
  );

  if (!access) {
    return null;
  }

  if (access.role === "client" && access.allowedViewers?.length) {
    const allowed = access.allowedViewers.some((viewer) =>
      Array.isArray(viewer.identifiers) &&
      viewer.identifiers.some((identifier) => normalizeViewerId(String(identifier)) === normalizedViewerId)
    );

    if (!allowed) {
      return null;
    }
  }

  return access;
}

function findGallery(slug) {
  if (!slug) return null;
  return (config.galleries || []).find(
    (gallery) => String(gallery.slug || "").toLowerCase() === String(slug || "").toLowerCase()
  );
}

function hasSpaceByteSource(gallery) {
  return Boolean(
    String(gallery.spacebyteRootFolderId || "").trim() ||
    String(gallery.spacebyteFolderPath || "").trim() ||
    String(gallery.spacebyteFolderName || "").trim()
  );
}

function getCachedHydratedGallery(slug) {
  const cached = galleryHydrationCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  return null;
}

function setCachedHydratedGallery(slug, data) {
  galleryHydrationCache.set(slug, { data, expiresAt: Date.now() + galleryCacheTtlMs });
}

function invalidateHydratedGalleryCache(slug) {
  galleryHydrationCache.delete(slug);
}

async function hydrateGalleryFromSpaceByte(gallery) {
  const eventFolder = await resolveEventFolder(gallery);
  if (!eventFolder) {
    throw new Error(`SpaceByte event folder was not found for '${gallery.eventName}'.`);
  }

  const configuredSceneNames = Array.isArray(gallery.sceneFolderNames) && gallery.sceneFolderNames.length
    ? gallery.sceneFolderNames
    : ["T.Photo", "C.Photo"];

  const childEntries = await spacebyteListAll({ folderId: eventFolder.id });
  const folderByName = new Map(
    childEntries
      .filter((entry) => entry.type === "folder")
      .map((entry) => [String(entry.name || "").toLowerCase(), entry])
  );

  const scenes = (
    await Promise.all(
      configuredSceneNames.map(async (sceneName) => {
        const sceneFolder = folderByName.get(String(sceneName || "").toLowerCase());
        if (!sceneFolder) return null;

        const sceneEntries = await spacebyteListAll({ folderId: sceneFolder.id });
        const images = sceneEntries
          .filter((entry) => entry.type === "image" || imageExtensions.has(String(entry.extension || "").toLowerCase()))
          .sort((a, b) => compareFilenamesNatural(a.name, b.name))
          .map((entry) => toGalleryImage(sceneName, entry));

        return {
          name: sceneName,
          spacebytePath: sceneFolder.path || "",
          images
        };
      })
    )
  ).filter(Boolean);

  const fallbackCover = scenes[0]?.images[0]?.thumbnailUrl || scenes[0]?.images[0]?.url || "";

  return {
    ...gallery,
    spacebyteRootFolderId: String(eventFolder.id),
    spacebyteRootFolderHash: String(eventFolder.hash || gallery.spacebyteRootFolderHash || ""),
    coverImage: String(gallery.coverImage || "").trim() || fallbackCover,
    apiDownloadAllUrl: `/api/galleries/${encodeURIComponent(gallery.slug)}/download-all`,
    scenes
  };
}

function compareFilenamesNatural(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

function toGalleryImage(sceneName, entry) {
  const hash = String(entry.hash || "");
  const filename = String(entry.name || entry.file_name || `image-${entry.id}.jpg`);
  const id = `${toSlug(sceneName)}-${entry.id}`;

  return {
    id,
    filename,
    spacebyteEntryId: String(entry.id || ""),
    spacebyteHash: hash,
    url: `/api/files/${encodeURIComponent(hash)}`,
    thumbnailUrl: `/api/files/${encodeURIComponent(hash)}`,
    downloadUrl: `/api/files/${encodeURIComponent(hash)}`
  };
}

async function resolveEventFolder(gallery) {
  const rootId = String(gallery.spacebyteRootFolderId || "").trim();
  if (rootId) {
    // Folder id/hash are already known from config, so query its children directly
    // instead of listing the parent/root (which the API forbids without a folderId filter).
    return {
      id: rootId,
      hash: String(gallery.spacebyteRootFolderHash || ""),
      path: ""
    };
  }

  const folderName = String(gallery.spacebyteFolderName || gallery.eventName || "").trim().toLowerCase();
  if (folderName) {
    const rootEntries = await spacebyteListAll({});
    const match = rootEntries.find((entry) =>
      entry.type === "folder" && String(entry.name || "").trim().toLowerCase() === folderName
    );
    if (match) return match;
  }

  const folderPath = String(gallery.spacebyteFolderPath || "").trim();
  if (folderPath) {
    const entries = await spacebyteListAll({ path: folderPath });
    const match = entries.find((entry) => entry.type === "folder");
    if (match) return match;
  }

  return null;
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

async function spacebyteFetchPage(filters, page) {
  const params = new URLSearchParams();
  params.set("page", String(page));

  if (filters?.folderId) {
    params.set("folderId", String(filters.folderId));
    params.set("parentId", String(filters.parentId || filters.folderId));
  }
  if (!filters?.folderId && filters?.parentId) {
    params.set("parentId", String(filters.parentId));
  }
  if (filters?.path) {
    params.set("path", String(filters.path));
  }

  return spacebyteJson(`${spacebyteBaseUrl}/drive/file-entries?${params.toString()}`);
}

function buildMetaFromGallery(gallery) {
  return {
    eventName: gallery.eventName,
    eventDate: gallery.eventDate,
    clientName: gallery.clientName,
    slug: gallery.slug,
    accessCodes: gallery.accessCodes || [],
    coverImage: gallery.coverImage || ""
  };
}

function ensureFavoritesStore() {
  fs.mkdirSync(path.dirname(favoritesStorePath), { recursive: true });
  if (!fs.existsSync(favoritesStorePath)) {
    fs.writeFileSync(favoritesStorePath, JSON.stringify({ submissions: [] }, null, 2) + "\n", "utf8");
  }
}

function readFavoritesStore() {
  return readJson(favoritesStorePath) || { submissions: [] };
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Failed to read JSON from ${filePath}:`, error.message);
    return null;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
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
  let filePath = normalized === "/" ? path.join(rootDir, "index.html") : path.join(rootDir, normalized.slice(1));

  if (!filePath.startsWith(rootDir)) {
    sendJson(response, 400, { error: "Invalid path." });
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[ext] || "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
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
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch (error) {
    console.error(`Failed to load env from ${filePath}:`, error.message);
    return {};
  }
}

async function spacebyteJson(url) {
  const headers = {};
  if (spacebyteToken) {
    headers.Authorization = `${spacebyteAuthScheme} ${spacebyteToken}`;
  }

  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = body ? ` - ${body.slice(0, 240)}` : "";
        throw new Error(`SpaceByte request failed with status ${response.status}${detail}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (error.name === "AbortError") {
      return await attempt();
    }
    throw error;
  }
}

