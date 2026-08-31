const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const NotificationService = require("./lib/notification-service");

const rootDir = __dirname;
const port = Number(process.env.PORT || 3002);
const env = { ...loadEnv(path.join(rootDir, ".env")), ...process.env };
const config = readJson(path.join(rootDir, "config", "galleries.json")) || { galleries: [] };
const notificationService = new NotificationService(path.join(rootDir, "config", "notifications.json"));
const googleDriveRootFolderId = String(env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "").trim();
const adminToken = String(env.ADMIN_TOKEN || "").trim();
const allowInsecureTls = String(env.GOOGLE_DRIVE_ALLOW_INSECURE_TLS || "").trim().toLowerCase() === "true";
const baseUrl = env.BASE_URL || `http://localhost:${port}`;
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const galleryCache = new Map();
const cacheTtlMs = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);
let tokenCache = null;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      serveStatic("/admin.html", response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/events") {
      if (!authorizeAdmin(request, response)) return;
      sendJson(response, 200, { events: config.galleries.map(toAdminEvent) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/events") {
      if (!authorizeAdmin(request, response)) return;
      await handleCreateAdminEvent(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/browse-google-drive-folders") {
      if (!authorizeAdmin(request, response)) return;
      await handleBrowseGoogleDriveFolders(request, response);
      return;
    }
    if (request.method === "PUT" && /^\/api\/admin\/events\/[^/]+$/.test(url.pathname)) {
      if (!authorizeAdmin(request, response)) return;
      await handleUpdateAdminEvent(url, request, response);
      return;
    }
    if (request.method === "GET" && /^\/api\/galleries\/[^/]+\/download-all$/.test(url.pathname)) {
      await handleDownloadAllRequest(url, response);
      return;
    }
    if (request.method === "POST" && /^\/api\/galleries\/[^/]+\/set-cover$/.test(url.pathname)) {
      await handleSetCover(url, request, response);
      return;
    }
    if (request.method === "POST" && /^\/api\/galleries\/[^/]+\/toggle-hide-photo$/.test(url.pathname)) {
      await handleToggleHidePhoto(url, request, response);
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
    if (request.method === "GET" && url.pathname.endsWith("/download-all")) return sendJson(response, 501, { error: "Download-all is not included in this POC yet." });
    serveStatic(url.pathname, response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Google Drive POC running at http://localhost:${port}`));

function authorizeAdmin(request, response) {
  if (!adminToken) {
    sendJson(response, 503, { error: "ADMIN_TOKEN is not configured in google-drive-poc/.env." });
    return false;
  }
  const provided = String(request.headers["x-admin-token"] || "").trim();
  if (provided !== adminToken) {
    sendJson(response, 401, { error: "Invalid admin token." });
    return false;
  }
  return true;
}

function toAdminEvent(gallery) {
  return {
    slug: gallery.slug,
    eventName: gallery.eventName,
    eventDate: gallery.eventDate || "",
    clientName: gallery.clientName || "",
    googleDriveFolderName: gallery.googleDriveFolderName || gallery.eventName || "",
    googleDriveFolderPath: gallery.googleDriveFolderPath || "",
    sceneFolderNames: gallery.sceneFolderNames || [],
    coverImage: gallery.coverImage || "",
    clientCode: getAccessCode(gallery, "client"),
    guestCode: getAccessCode(gallery, "guest")
  };
}

async function handleCreateAdminEvent(request, response) {
  const body = await readJsonBody(request);
  const eventName = String(body.eventName || "").trim();
  const slug = toSlug(String(body.slug || eventName));
  const clientCode = String(body.clientCode || "").trim();
  if (!eventName || !slug || !clientCode) {
    sendJson(response, 400, { error: "eventName, slug, and clientCode are required." });
    return;
  }
  if (!googleDriveRootFolderId) {
    sendJson(response, 503, { error: "GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured." });
    return;
  }
  if (config.galleries.some((gallery) => gallery.slug === slug)) {
    sendJson(response, 409, { error: `Event slug '${slug}' already exists.` });
    return;
  }
  const gallery = {
    slug,
    eventName,
    eventDate: String(body.eventDate || "").trim(),
    clientName: String(body.clientName || "").trim(),
    googleDriveFolderName: String(body.googleDriveFolderName || eventName).trim(),
    googleDriveFolderPath: String(body.googleDriveFolderPath || "").trim(),
    sceneFolderNames: Array.isArray(body.sceneFolderNames) ? body.sceneFolderNames.map(String).map((name) => name.trim()).filter(Boolean) : [],
    coverImage: String(body.coverImage || "").trim(),
    accessCodes: createAccessCodes(clientCode, String(body.guestCode || "guest").trim() || "guest")
  };
  config.galleries.push(gallery);
  writeConfig();

  // Send notification for event creation
  try {
    const guestCode = getAccessCode(gallery, "guest");
    const clientCodeText = clientCode;
    const galleryUrl = `${baseUrl}/?event=${encodeURIComponent(slug)}`;
    const googleDriveRootUrl = `https://drive.google.com/drive/folders/${googleDriveRootFolderId}`;
    
    await notificationService.notifyEventCreated(gallery, guestCode, clientCodeText, galleryUrl, googleDriveRootUrl);
  } catch (notifyError) {
    console.error(`Failed to send event creation notification: ${notifyError.message}`);
  }

  sendJson(response, 201, { ok: true, event: toAdminEvent(gallery) });
}

async function handleUpdateAdminEvent(url, request, response) {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[3] || "");
  const gallery = findGallery(slug);
  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }
  const body = await readJsonBody(request);
  for (const field of ["eventName", "eventDate", "clientName", "googleDriveFolderName", "googleDriveFolderPath", "coverImage"]) {
    if (body[field] !== undefined) gallery[field] = String(body[field] || "").trim();
  }
  if (Array.isArray(body.sceneFolderNames)) gallery.sceneFolderNames = body.sceneFolderNames.map(String).map((name) => name.trim()).filter(Boolean);
  if (body.clientCode !== undefined) setAccessCode(gallery, "client", String(body.clientCode).trim());
  if (body.guestCode !== undefined) setAccessCode(gallery, "guest", String(body.guestCode).trim());
  writeConfig();
  galleryCache.delete(slug);
  sendJson(response, 200, { ok: true, event: toAdminEvent(gallery) });
}

async function handleBrowseGoogleDriveFolders(request, response) {
  const body = await readJsonBody(request);
  const searchTerm = String(body.searchTerm || "").trim().toLowerCase();
  const parentId = String(body.parentId || await resolveStarzShotsRootId()).trim();
  if (!parentId) {
    sendJson(response, 503, { error: "GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured." });
    return;
  }
  const folders = await listDriveFiles(parentId, true);
  const filtered = searchTerm ? folders.filter((folder) => folder.name.toLowerCase().includes(searchTerm)) : folders;
  sendJson(response, 200, { folders: filtered.slice(0, 100).map((folder) => ({ id: folder.id, name: folder.name, path: folder.name })) });
}

function createAccessCodes(clientCode, guestCode) {
  return [
    { label: "Client", code: clientCode, role: "client", permissions: { canFavorite: true, canDownloadSingle: true, canDownloadAll: true } },
    { label: "Guest", code: guestCode, role: "guest", permissions: { canFavorite: true, canDownloadSingle: true, canDownloadAll: false } }
  ];
}

function getAccessCode(gallery, role) { return (gallery.accessCodes || []).find((access) => access.role === role)?.code || ""; }
function setAccessCode(gallery, role, code) { const access = (gallery.accessCodes || []).find((entry) => entry.role === role); if (access) access.code = code; }
function toSlug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function writeConfig() { fs.writeFileSync(path.join(rootDir, "config", "galleries.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8"); }
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

async function handleGalleryRequest(url, response) {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] || "");
  const gallery = findGallery(slug);
  if (!gallery) return sendJson(response, 404, { error: "Gallery not found." });
  if (url.pathname.endsWith("/meta")) {
    const hydrated = await hydrateGallery(gallery);
    return sendJson(response, 200, buildMeta(hydrated));
  }
  const cached = galleryCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return sendJson(response, 200, cached.gallery);
  const hydrated = await hydrateGallery(gallery);
  galleryCache.set(slug, { gallery: hydrated, expiresAt: Date.now() + cacheTtlMs });
  sendJson(response, 200, hydrated);
}

async function handleDownloadAllRequest(url, response) {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] || "");
  const gallery = findGallery(slug);
  if (!gallery) {
    sendJson(response, 404, { error: "Gallery not found." });
    return;
  }

  const hydrated = await hydrateGallery(gallery);
  const images = hydrated.scenes.flatMap((scene) => scene.images);
  if (!images.length) {
    sendJson(response, 404, { error: "No images found for this gallery." });
    return;
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "starzshots-") );
  const zipPath = path.join(os.tmpdir(), `${slug}-${Date.now()}.zip`);
  try {
    for (const image of images) {
      const fileName = `${String(image.filename || image.id).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const upstream = await driveStream(`/drive/v3/files/${encodeURIComponent(image.googleDriveFileId)}?alt=media`);
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        upstream.resume();
        throw new Error(`Google Drive could not download '${image.filename}'.`);
      }
      await pipeline(upstream, fs.createWriteStream(path.join(tempDir, fileName)));
    }

    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path (Get-ChildItem -LiteralPath '${tempDir.replace(/'/g, "''")}').FullName -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ]);

    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`
    });
    await pipeline(fs.createReadStream(zipPath), response);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    await fs.promises.rm(zipPath, { force: true });
  }
}

async function hydrateGallery(gallery) {
  const eventFolder = await resolveEventFolder(gallery);
  if (!eventFolder) throw new Error(`Google Drive event folder '${gallery.googleDriveFolderName || gallery.eventName}' was not found under the configured root folder.`);
  const childFolders = await listDriveFiles(eventFolder.id, true);
  const configuredScenes = Array.isArray(gallery.sceneFolderNames) && gallery.sceneFolderNames.length
    ? gallery.sceneFolderNames
    : childFolders.map((folder) => folder.name);
  const folderByName = new Map(childFolders.map((folder) => [folder.name.toLowerCase(), folder]));
  const scenes = (await Promise.all(configuredScenes.map(async (sceneName) => {
    const sceneFolder = folderByName.get(String(sceneName).toLowerCase());
    if (!sceneFolder) return null;
    const files = await listDriveFiles(sceneFolder.id, false);
    const images = files
      .filter((file) => imageExtensions.has(path.extname(file.name).slice(1).toLowerCase()) || file.mimeType.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
      .map((file) => ({ id: file.id, filename: file.name, googleDriveFileId: file.id, url: `/api/files/${encodeURIComponent(file.id)}`, thumbnailUrl: `/api/files/${encodeURIComponent(file.id)}`, downloadUrl: `/api/files/${encodeURIComponent(file.id)}` }));
    return { name: sceneName, images };
  }))).filter(Boolean);
  return { ...gallery, coverImage: String(gallery.coverImage || "").trim() || scenes[0]?.images[0]?.thumbnailUrl || "", apiDownloadAllUrl: `/api/galleries/${encodeURIComponent(gallery.slug)}/download-all`, scenes };
}

async function resolveEventFolder(gallery) {
  if (!googleDriveRootFolderId) throw new Error("Set GOOGLE_DRIVE_ROOT_FOLDER_ID to the Starz Shots folder ID in google-drive-poc/.env.");

  const configuredPath = String(gallery.googleDriveFolderPath || "").trim();
  const pathParts = configuredPath ? configuredPath.split("/").map((part) => part.trim()).filter(Boolean) : [];
  const folderNames = pathParts.length ? pathParts : [String(gallery.googleDriveFolderName || gallery.eventName || "").trim()];
  const configuredRootId = await resolveStarzShotsRootId();
  let parentId = configuredRootId;

  // If the configured root is already the event folder, allow that setup.
  if (folderNames.length === 1 && folderNames[0]) {
    const rootDetails = await getDriveFile(configuredRootId);
    if (normalizeName(rootDetails?.name) === normalizeName(folderNames[0])) {
      return { id: configuredRootId };
    }
  }

  for (const folderName of folderNames) {
    if (!folderName) return null;
    const folders = await listDriveFiles(parentId, true);
    const match = folders.find((folder) => normalizeName(folder.name) === normalizeName(folderName));
    if (!match) {
      const available = folders.map((folder) => String(folder.name || "")).filter(Boolean).slice(0, 20);
      throw new Error(
        `Google Drive event folder '${folderName}' was not found under the configured root folder. ` +
        (available.length ? `Available folders under this level: ${available.join(", ")}.` : "No child folders were found under this root folder.")
      );
    }
    parentId = match.id;
  }

  return { id: parentId };
}

async function listDriveFiles(parentId, foldersOnly) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q: `'${parentId}' in parents and trashed = false${foldersOnly ? " and mimeType = 'application/vnd.google-apps.folder'" : ""}`, pageSize: "1000", fields: "nextPageToken,files(id,name,mimeType,size)", orderBy: "name" });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await driveJson(`/drive/v3/files?${params}`);
    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function handleFileDownload(url, response) {
  const fileId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] || "");
  if (!fileId) return sendJson(response, 400, { error: "Missing Google Drive file ID." });
  const upstream = await driveStream(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    upstream.resume();
    return sendJson(response, upstream.statusCode || 502, { error: `Google Drive download failed with status ${upstream.statusCode}.` });
  }
  response.writeHead(200, { "Content-Type": upstream.headers["content-type"] || "application/octet-stream", "Content-Length": upstream.headers["content-length"] || undefined, "Content-Disposition": "inline" });
  await pipeline(upstream, response);
}

async function handleSetCover(url, request, response) {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] || "");
  const gallery = findGallery(slug);
  if (!gallery) {
    return sendJson(response, 404, { error: "Gallery not found." });
  }

  const body = await readJsonBody(request);
  const photoId = String(body.photoId || "").trim();
  const filename = String(body.filename || "").trim();

  if (!photoId) {
    return sendJson(response, 400, { error: "photoId is required." });
  }

  try {
    gallery.coverImage = `/api/files/${encodeURIComponent(photoId)}`;
    writeConfig();
    galleryCache.delete(slug);
    sendJson(response, 200, { ok: true, coverImage: gallery.coverImage });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

async function handleToggleHidePhoto(url, request, response) {
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] || "");
  const gallery = findGallery(slug);
  if (!gallery) {
    return sendJson(response, 404, { error: "Gallery not found." });
  }

  const body = await readJsonBody(request);
  const photoId = String(body.photoId || "").trim();
  const viewerId = String(body.viewerId || "").trim();

  if (!photoId || !viewerId) {
    return sendJson(response, 400, { error: "photoId and viewerId are required." });
  }

  try {
    const hiddenPhotosPath = getHiddenPhotosPath(slug);
    const hiddenPhotos = readHiddenPhotos(hiddenPhotosPath);

    if (!hiddenPhotos[viewerId]) {
      hiddenPhotos[viewerId] = [];
    }

    const index = hiddenPhotos[viewerId].indexOf(photoId);
    if (index >= 0) {
      hiddenPhotos[viewerId].splice(index, 1);
    } else {
      hiddenPhotos[viewerId].push(photoId);
    }

    writeHiddenPhotos(hiddenPhotosPath, hiddenPhotos);
    galleryCache.delete(slug);
    sendJson(response, 200, { ok: true, isHidden: !hiddenPhotos[viewerId].includes(photoId) });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

async function driveJson(apiPath) {
  const result = await httpsRequest(`https://www.googleapis.com${apiPath}`, { Authorization: `Bearer ${await getAccessToken()}` });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(formatGoogleApiError(result.statusCode, result.body));
  }
  return JSON.parse(result.body);
}

async function driveStream(apiPath) { return httpsStream(`https://www.googleapis.com${apiPath}`, { Authorization: `Bearer ${await getAccessToken()}` }); }

async function getDriveFile(fileId) {
  return driveJson(`/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents`);
}

async function resolveStarzShotsRootId() {
  if (!googleDriveRootFolderId) return "";
  let current = await getDriveFile(googleDriveRootFolderId);
  for (let level = 0; level < 6 && current; level += 1) {
    if (normalizeName(current.name) === "starz shots") return current.id;
    const parentId = current.parents?.[0];
    if (!parentId) break;
    current = await getDriveFile(parentId);
  }
  return googleDriveRootFolderId;
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  const credentials = getCredentials();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${base64Url(signer.sign(credentials.private_key))}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
  const result = await httpsRequest("https://oauth2.googleapis.com/token", { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }, "POST", body);
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`Google token request failed with status ${result.statusCode}: ${result.body.slice(0, 240)}`);
  const payload = JSON.parse(result.body);
  tokenCache = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

function getCredentials() {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || (env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ? Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8") : "");
  if (!raw) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 in google-drive-poc/.env.");
  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) throw new Error("Service-account JSON must include client_email and private_key.");
  return credentials;
}

function base64Url(value) { return Buffer.from(value).toString("base64url"); }
function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}
function formatGoogleApiError(statusCode, body) {
  try {
    const payload = JSON.parse(body);
    const message = String(payload?.error?.message || "").trim();
    if (message) return `Google Drive request failed (${statusCode}): ${message}`;
  } catch {
    // Fall through to the generic message below.
  }
  return `Google Drive request failed with status ${statusCode}.`;
}
function findGallery(slug) { return (config.galleries || []).find((gallery) => gallery.slug === slug); }
function buildMeta(gallery) { return { eventName: gallery.eventName, eventDate: gallery.eventDate, clientName: gallery.clientName, slug: gallery.slug, accessCodes: gallery.accessCodes || [], coverImage: gallery.coverImage || "" }; }
function readJson(filePath) { try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null; } catch { return null; } }
function sendJson(response, statusCode, payload) { response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(payload)); }
function serveStatic(urlPath, response) { const relative = decodeURIComponent(urlPath.split("?")[0] || "/"); const filePath = path.join(rootDir, relative === "/" ? "index.html" : relative.slice(1)); if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(response, 404, { error: "Not found." }); const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }; response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" }); response.end(fs.readFileSync(filePath)); }
function loadEnv(filePath) { if (!fs.existsSync(filePath)) return {}; return Object.fromEntries(fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line && !line.trim().startsWith("#")).map((line) => { const index = line.indexOf("="); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")]; })); }
function httpsRequest(url, headers, method = "GET", body = "") { return new Promise((resolve, reject) => { const request = https.request(url, { method, headers, rejectUnauthorized: !allowInsecureTls }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") })); }); request.on("error", reject); request.end(body); }); }
function httpsStream(url, headers) { return new Promise((resolve, reject) => { const request = https.get(url, { headers, rejectUnauthorized: !allowInsecureTls }, resolve); request.on("error", reject); }); }

function getHiddenPhotosPath(slug) {
  return path.join(rootDir, "data", `${slug}-hidden-photos.json`);
}

function readHiddenPhotos(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeHiddenPhotos(filePath, hiddenPhotos) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(hiddenPhotos, null, 2)}\n`, "utf8");
}