const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 8080);
const env = loadEnv(path.join(rootDir, ".env"));
const galleriesConfigPath = path.join(rootDir, "config", "galleries.json");
const config = readJson(galleriesConfigPath);
const favoritesStorePath = path.join(rootDir, "data", "favorites-submissions.json");

const spacebyteBaseUrl = env.SPACEBYTE_BASE_URL || "https://spacebyte.in/api/v1";
const spacebyteToken = env.SPACEBYTE_TOKEN || "";
const adminToken = env.ADMIN_TOKEN || "";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

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
          spacebyteRootFolderId: gallery.spacebyteRootFolderId || "",
          spacebyteFolderPath: gallery.spacebyteFolderPath || "",
          clientCode: getAccessCode(gallery, "client"),
          guestCode: getAccessCode(gallery, "guest"),
          allowedViewers: getAllowedViewerSummary(gallery)
        }))
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/events") {
      if (!authorizeAdmin(request, response)) return;
      await handleCreateAdminEvent(request, response);
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
  fs.writeFileSync(galleriesConfigPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    favorites: favorites.map((entry) => ({
      scene: String(entry.scene || ""),
      sceneIndex: Number(entry.sceneIndex || 0),
      filename: String(entry.filename || ""),
      spacebyteEntryId: String(entry.spacebyteEntryId || ""),
      spacebyteHash: String(entry.spacebyteHash || "")
    }))
  });

  writeFavoritesStore(store);
  sendJson(response, 200, { ok: true, submissionId, totalFavorites: favorites.length });
}

async function handleDeleteFileRequest(request, url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const entryId = decodeURIComponent(parts[2] || "");

  if (!entryId) {
    sendJson(response, 400, { error: "Missing file entry ID." });
    return;
  }

  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured." });
    return;
  }

  const body = await readJsonBody(request);
  const slug = String(body.slug || "").trim();
  const viewerId = normalizeViewerId(body.viewerId || "");
  const accessCode = String(body.accessCode || "").trim();
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const access = resolveAccess(gallery, viewerId, accessCode);
  if (!access || access.role !== "client") {
    sendJson(response, 403, { error: "Only client access can remove photos." });
    return;
  }

  await deleteSpaceByteEntry(entryId);
  sendJson(response, 200, { ok: true, removedEntryId: entryId });
}

async function handleFavoritesCsvRequest(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(parts[2] || "");
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const viewerId = normalizeViewerId(url.searchParams.get("viewerId") || "");
  const accessCode = String(url.searchParams.get("accessCode") || "").trim();
  const access = resolveAccess(gallery, viewerId, accessCode);

  if (!access || access.role !== "client") {
    sendJson(response, 403, { error: "Only client access can export favorites CSV." });
    return;
  }

  const store = readFavoritesStore();
  const rows = store.submissions
    .filter((entry) => entry.slug === slug)
    .flatMap((entry) => entry.favorites.map((favorite) => ({
      submissionId: entry.submissionId,
      submittedAt: entry.submittedAt,
      guestId: entry.viewerId,
      guestLabel: entry.viewerLabel,
      scene: favorite.scene,
      sceneIndex: favorite.sceneIndex,
      filename: favorite.filename,
      spacebyteEntryId: favorite.spacebyteEntryId,
      spacebyteHash: favorite.spacebyteHash
    })));

  const csv = toCsv(rows, [
    "submissionId",
    "submittedAt",
    "guestId",
    "guestLabel",
    "scene",
    "sceneIndex",
    "filename",
    "spacebyteEntryId",
    "spacebyteHash"
  ]);

  const safeSlug = slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${safeSlug}-favorites.csv"`
  });
  response.end(csv);
}

function findGallery(slug) {
  return config.galleries.find((entry) => entry.slug === slug);
}

function resolveAccess(gallery, viewerId, accessCode) {
  const normalizedCode = String(accessCode || "").trim().toLowerCase();
  const normalizedViewer = normalizeViewerId(viewerId || "");
  const access = (gallery.accessCodes || []).find((entry) =>
    String(entry.code || "").trim().toLowerCase() === normalizedCode
  );

  if (!access) {
    return null;
  }

  if (access.role !== "client" || !access.allowedViewers?.length) {
    return access;
  }

  const isAllowed = access.allowedViewers.some((viewer) =>
    (viewer.identifiers || []).some((identifier) => normalizeViewerId(identifier) === normalizedViewer)
  );

  return isAllowed ? access : null;
}

function normalizeViewerId(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function ensureFavoritesStore() {
  if (fs.existsSync(favoritesStorePath)) return;
  writeFavoritesStore({ submissions: [] });
}

function readFavoritesStore() {
  ensureFavoritesStore();
  const parsed = readJson(favoritesStorePath);
  const submissions = Array.isArray(parsed.submissions) ? parsed.submissions : [];
  return { submissions };
}

function writeFavoritesStore(payload) {
  fs.writeFileSync(favoritesStorePath, JSON.stringify(payload, null, 2));
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function deleteSpaceByteEntry(entryId) {
  const parsedId = Number(entryId);
  const normalizedId = Number.isFinite(parsedId) ? parsedId : String(entryId);
  const attempts = [
    {
      label: "entryIds-deleteForever",
      url: `${spacebyteBaseUrl}/file-entries?deleteForever=true`,
      method: "DELETE",
      body: { entryIds: [normalizedId], deleteForever: true }
    },
    {
      label: "entryIds-standard",
      url: `${spacebyteBaseUrl}/file-entries`,
      method: "DELETE",
      body: { entryIds: [normalizedId] }
    }
  ];

  const errors = [];

  for (const attempt of attempts) {
    const result = await fetch(attempt.url, {
      method: attempt.method,
      headers: {
        Authorization: `Bearer ${spacebyteToken}`,
        Accept: "application/json",
        "content-type": "application/json"
      },
      body: attempt.body ? JSON.stringify(attempt.body) : undefined
    });

    if (result.ok) {
      return;
    }

    const errorText = await result.text();
    errors.push(`${attempt.label} -> ${result.status}: ${errorText}`);
  }

  throw new Error(`SpaceByte delete failed for entry ${entryId}. Attempts: ${errors.join(" | ")}`);
}

async function handleGalleryRequest(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts[2];
  const isMetaRequest = parts[3] === "meta";
  const isFullDownload = parts[3] === "download";
  const gallery = config.galleries.find((entry) => entry.slug === slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  if (isMetaRequest) {
    sendJson(response, 200, buildGalleryMeta(gallery));
    return;
  }

  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured." });
    return;
  }

  const hydratedGallery = await buildGalleryFromSpaceByte(gallery);

  if (isFullDownload) {
    const hashes = hydratedGallery.scenes
      .flatMap((scene) => scene.images)
      .map((image) => image.spacebyteHash)
      .filter(Boolean)
      .join(",");

    if (!hashes) {
      sendJson(response, 404, { error: "No downloadable files found." });
      return;
    }

    await proxySpaceByteDownload(hashes, response);
    return;
  }

  sendJson(response, 200, hydratedGallery);
}

function buildGalleryMeta(gallery) {
  return {
    eventName: gallery.eventName,
    eventDate: gallery.eventDate,
    clientName: gallery.clientName,
    slug: gallery.slug,
    accessCodes: gallery.accessCodes || [],
    coverImage: gallery.coverImage || ""
  };
}

async function handleFileDownload(url, response) {
  const parts = url.pathname.split("/").filter(Boolean);
  const hash = decodeURIComponent(parts[2] || "");

  if (!spacebyteToken) {
    sendJson(response, 503, { error: "SPACEBYTE_TOKEN is not configured." });
    return;
  }

  if (!hash) {
    sendJson(response, 400, { error: "Missing SpaceByte file hash." });
    return;
  }

  await proxySpaceByteDownload(hash, response);
}

async function buildGalleryFromSpaceByte(gallery) {
  const rootEntries = await listSpaceByteEntries({
    folderId: gallery.spacebyteRootFolderId,
    path: gallery.spacebyteFolderPath
  });

  const folders = rootEntries.filter(isFolderEntry);
  const rootImages = rootEntries.filter(isImageEntry);
  const sceneSources = folders.length
    ? folders.map((folder) => ({ name: getEntryName(folder), folder }))
    : [{ name: "Photos", images: rootImages }];

  const scenes = [];

  for (const source of sceneSources) {
    const images = source.images || (await listSpaceByteEntries({
      folderId: getEntryId(source.folder),
      path: joinSpaceBytePath(gallery.spacebyteFolderPath, getEntryName(source.folder))
    })).filter(isImageEntry);

    scenes.push({
      name: source.name,
      spacebytePath: joinSpaceBytePath(gallery.spacebyteFolderPath, source.name),
      images: images.map(toGalleryImage)
    });
  }

  const firstImage = scenes.flatMap((scene) => scene.images)[0];

  return {
    eventName: gallery.eventName,
    eventDate: gallery.eventDate,
    clientName: gallery.clientName,
    slug: gallery.slug,
    accessCodes: gallery.accessCodes,
    spacebyteFolderPath: gallery.spacebyteFolderPath,
    coverImage: gallery.coverImage || firstImage?.thumbnailUrl || firstImage?.url || "",
    apiDownloadAllUrl: `/api/galleries/${encodeURIComponent(gallery.slug)}/download`,
    scenes
  };
}

async function listSpaceByteEntries({ folderId, path: folderPath }) {
  const params = new URLSearchParams();

  if (folderId) {
    params.set("folderId", folderId);
    params.set("parentId", folderId);
  }

  if (folderPath) {
    params.set("path", folderPath);
  }

  const allEntries = [];
  let page = 1;
  let safetyCounter = 0;

  while (safetyCounter < 500) {
    params.set("page", String(page));
    const url = `${spacebyteBaseUrl}/drive/file-entries${params.toString() ? `?${params}` : ""}`;
    const payload = await spacebyteJson(url);
    const entries = unwrapEntries(payload);

    if (!entries.length) {
      break;
    }

    allEntries.push(...entries);

    const nextPage = getNextPage(payload);
    if (!nextPage || nextPage <= page) {
      break;
    }

    page = nextPage;
    safetyCounter += 1;
  }

  return allEntries;
}

async function proxySpaceByteDownload(hashes, response) {
  const encodedHashes = hashes.split(",").map((hash) => encodeURIComponent(hash)).join(",");
  const url = `${spacebyteBaseUrl}/file-entries/download/${encodedHashes}`;
  const spacebyteResponse = await fetch(url, {
    headers: {
      Authorization: `Bearer ${spacebyteToken}`
    },
    redirect: "manual"
  });

  if ([301, 302, 303, 307, 308].includes(spacebyteResponse.status)) {
    const redirectUrl = spacebyteResponse.headers.get("location");

    if (!redirectUrl) {
      sendJson(response, 502, { error: "SpaceByte redirect response did not include a location." });
      return;
    }

    await proxyBinaryFromUrl(redirectUrl, response);
    return;
  }

  const contentType = spacebyteResponse.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await spacebyteResponse.json();
    const downloadUrl = payload.url || payload.downloadUrl || payload.link || payload.data?.url || payload.data?.downloadUrl;

    if (downloadUrl) {
      await proxyBinaryFromUrl(downloadUrl, response);
      return;
    }

    sendJson(response, spacebyteResponse.status, payload);
    return;
  }

  response.writeHead(spacebyteResponse.status, {
    "content-type": contentType || "application/octet-stream",
    "content-disposition": spacebyteResponse.headers.get("content-disposition") || "attachment"
  });

  const buffer = Buffer.from(await spacebyteResponse.arrayBuffer());
  response.end(buffer);
}

async function proxyBinaryFromUrl(url, response) {
  const upstreamResponse = await fetch(url, { redirect: "follow" });

  if (!upstreamResponse.ok) {
    sendJson(response, upstreamResponse.status, { error: "Unable to fetch file from SpaceByte storage." });
    return;
  }

  const rawContentType = upstreamResponse.headers.get("content-type") || "application/octet-stream";
  const contentDisposition = upstreamResponse.headers.get("content-disposition");
  const contentLength = upstreamResponse.headers.get("content-length");
  const inferredType = inferMimeTypeFromFilename(contentDisposition, url);
  const contentType = rawContentType.startsWith("application/octet-stream") && inferredType
    ? inferredType
    : rawContentType;
  const headers = {
    "content-type": contentType,
    "cache-control": "private, max-age=300"
  };

  if (contentDisposition) {
    headers["content-disposition"] = contentDisposition;
  }

  if (contentLength) {
    headers["content-length"] = contentLength;
  }

  response.writeHead(200, headers);
  const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
  response.end(buffer);
}

function inferMimeTypeFromFilename(contentDisposition, sourceUrl) {
  const filename = extractFilename(contentDisposition, sourceUrl).toLowerCase();

  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  if (filename.endsWith(".avif")) return "image/avif";
  return "";
}

function extractFilename(contentDisposition, sourceUrl) {
  if (contentDisposition) {
    const starMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (starMatch && starMatch[1]) {
      return decodeURIComponent(starMatch[1]);
    }

    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (plainMatch && plainMatch[1]) {
      return plainMatch[1];
    }
  }

  try {
    const parsed = new URL(sourceUrl);
    const fromDispositionParam = parsed.searchParams.get("response-content-disposition");

    if (fromDispositionParam) {
      const plainMatch = fromDispositionParam.match(/filename="?([^";]+)"?/i);
      if (plainMatch && plainMatch[1]) {
        return plainMatch[1];
      }
    }
  } catch {
    return "";
  }

  return "";
}

async function spacebyteJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${spacebyteToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`SpaceByte request failed with ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function unwrapEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.data)) return payload.data.data;
  if (Array.isArray(payload.fileEntries)) return payload.fileEntries;
  if (Array.isArray(payload.entries)) return payload.entries;
  return [];
}

function getNextPage(payload) {
  const nextValue = payload?.next_page ?? payload?.data?.next_page ?? payload?.meta?.next_page ?? null;

  if (typeof nextValue === "number" && Number.isFinite(nextValue)) {
    return nextValue;
  }

  if (typeof nextValue === "string" && nextValue.trim()) {
    const directNumeric = Number(nextValue);
    if (Number.isFinite(directNumeric)) {
      return directNumeric;
    }

    try {
      const parsed = new URL(nextValue);
      const pageParam = Number(parsed.searchParams.get("page"));
      if (Number.isFinite(pageParam)) {
        return pageParam;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function toGalleryImage(entry) {
  const hash = getEntryHash(entry);
  const filename = getEntryName(entry);
  const id = getEntryId(entry) || hash || filename;
  // SpaceByte's raw entry.url is a private API path that requires the Authorization
  // header, so it can't be used directly in an <img> src - always route through our proxy.
  const downloadUrl = hash ? `/api/files/${encodeURIComponent(hash)}/download` : entry.url || entry.downloadUrl || "";

  return {
    id,
    filename,
    url: downloadUrl,
    thumbnailUrl: downloadUrl,
    downloadUrl,
    spacebyteEntryId: getEntryId(entry),
    spacebyteHash: hash
  };
}

function isFolderEntry(entry) {
  const type = String(entry.type || entry.kind || entry.mime || "").toLowerCase();
  return Boolean(entry.isFolder || type === "folder" || type === "dir" || type === "directory");
}

function isImageEntry(entry) {
  const filename = getEntryName(entry).toLowerCase();
  const mime = String(entry.mime || entry.mimeType || entry.type || "").toLowerCase();
  return mime.startsWith("image/") || /\.(avif|gif|jpe?g|png|webp)$/i.test(filename);
}

function getEntryId(entry) {
  return entry.id || entry.entryId || entry.fileEntryId || entry.uuid || "";
}

function getEntryHash(entry) {
  return entry.hash || entry.fileHash || entry.downloadHash || entry.urlHash || entry.uuid || getEntryId(entry);
}

function getEntryName(entry) {
  return entry.name || entry.filename || entry.fileName || entry.basename || "Untitled";
}

function joinSpaceBytePath(parent, child) {
  if (!parent) return child || "";
  if (!child) return parent;
  return `${parent.replace(/\/$/, "")}/${child.replace(/^\//, "")}`;
}

function serveStatic(requestPath, response) {
  const cleanPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  const filePath = path.normalize(path.join(rootDir, cleanPath));

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(content);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return process.env;

  const parsed = { ...process.env };
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    parsed[key] = value;
  }

  return parsed;
}
