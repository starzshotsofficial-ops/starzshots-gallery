const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 8080);
const env = loadEnv(path.join(rootDir, ".env"));
const galleriesConfigPath = path.join(rootDir, "config", "galleries.json");
const config = readJson(galleriesConfigPath) || { galleries: [] };
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
  fs.writeFileSync(galleriesConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
  const gallery = findGallery(slug);

  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  if (url.pathname.endsWith("/meta")) {
    sendJson(response, 200, buildMetaFromGallery(gallery));
    return;
  }

  sendJson(response, 200, gallery);
}

async function handleFileDownload(url, response) {
  sendJson(response, 501, { error: "File download is not implemented." });
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
    headers.Authorization = `Bearer ${spacebyteToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`SpaceByte request failed with status ${response.status}`);
  }

  return response.json();
}
