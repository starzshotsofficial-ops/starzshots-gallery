"use strict";

const https = require("https");
const crypto = require("crypto");

const API_ORIGIN = "https://www.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,thumbnailLink";

function createDriveClient({ env, allowInsecureTls, rootFolderId }) {
  let tokenCache = null;

  async function getAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;

    const credentials = readCredentials(env);
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: DRIVE_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600
      })
    );
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${base64Url(signer.sign(credentials.private_key))}`;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();

    const result = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      body
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`Google token request failed with status ${result.statusCode}.`);
    }

    const payload = JSON.parse(result.body);
    tokenCache = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
    return tokenCache.value;
  }

  async function apiJson(apiPath) {
    const result = await request(`${API_ORIGIN}${apiPath}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(formatApiError(result.statusCode, result.body));
    }
    return JSON.parse(result.body);
  }

  async function listFiles(parentId, foldersOnly) {
    const files = [];
    let pageToken = "";

    do {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and trashed = false${foldersOnly ? " and mimeType = 'application/vnd.google-apps.folder'" : ""}`,
        pageSize: "1000",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        orderBy: "name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });
      if (pageToken) params.set("pageToken", pageToken);

      const payload = await apiJson(`/drive/v3/files?${params}`);
      files.push(...(payload.files || []));
      pageToken = payload.nextPageToken || "";
    } while (pageToken);

    return files;
  }

  function getFile(fileId) {
    const params = new URLSearchParams({ fields: `${FILE_FIELDS},parents`, supportsAllDrives: "true" });
    return apiJson(`/drive/v3/files/${encodeURIComponent(fileId)}?${params}`);
  }

  async function streamOriginal(fileId) {
    return stream(`${API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      Authorization: `Bearer ${await getAccessToken()}`
    });
  }

  /** Drive thumbnail links expire within hours, so callers must fetch fresh metadata before using them. */
  async function streamThumbnail(thumbnailLink, size) {
    if (!thumbnailLink) return null;

    const sized = String(thumbnailLink).replace(/=s\d+(-[a-z0-9]+)?$/i, `=s${size}`);
    const response = await stream(sized, {});
    if (response.statusCode === 401 || response.statusCode === 403) {
      response.resume();
      return stream(sized, { Authorization: `Bearer ${await getAccessToken()}` });
    }
    return response;
  }

  async function resolveRootFolderId() {
    if (!rootFolderId) return "";

    let current = await getFile(rootFolderId);
    for (let level = 0; level < 6 && current; level += 1) {
      if (normalizeName(current.name) === "starz shots") return current.id;
      const parentId = current.parents?.[0];
      if (!parentId) break;
      current = await getFile(parentId);
    }
    return rootFolderId;
  }

  async function resolveEventFolderId(gallery) {
    if (!rootFolderId) {
      throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured.");
    }

    const configuredPath = String(gallery.googleDriveFolderPath || "").trim();
    const pathParts = configuredPath ? configuredPath.split("/").map((part) => part.trim()).filter(Boolean) : [];
    const folderNames = pathParts.length ? pathParts : [String(gallery.googleDriveFolderName || gallery.eventName || "").trim()];
    const resolvedRootId = await resolveRootFolderId();

    if (folderNames.length === 1 && folderNames[0]) {
      const rootDetails = await getFile(resolvedRootId);
      if (normalizeName(rootDetails?.name) === normalizeName(folderNames[0])) return resolvedRootId;
    }

    let parentId = resolvedRootId;
    for (const folderName of folderNames) {
      if (!folderName) throw new Error("The event is missing a Google Drive folder name.");
      const folders = await listFiles(parentId, true);
      const match = folders.find((folder) => normalizeName(folder.name) === normalizeName(folderName));
      if (!match) {
        const available = folders.map((folder) => folder.name).filter(Boolean).slice(0, 20);
        throw new Error(
          `Google Drive folder '${folderName}' was not found. ` +
            (available.length ? `Available folders at this level: ${available.join(", ")}.` : "No sub-folders exist at this level.")
        );
      }
      parentId = match.id;
    }

    return parentId;
  }

  function request(url, { method = "GET", headers = {}, body = "" } = {}) {
    return new Promise((resolve, reject) => {
      const clientRequest = https.request(url, { method, headers, rejectUnauthorized: !allowInsecureTls }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      clientRequest.on("error", reject);
      clientRequest.end(body);
    });
  }

  function stream(url, headers, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const clientRequest = https.get(url, { headers, rejectUnauthorized: !allowInsecureTls }, (response) => {
        const location = response.headers.location;
        if (response.statusCode >= 300 && response.statusCode < 400 && location && redirectsLeft > 0) {
          response.resume();
          stream(new URL(location, url).toString(), headers, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        resolve(response);
      });
      clientRequest.on("error", reject);
    });
  }

  return { listFiles, getFile, streamOriginal, streamThumbnail, resolveEventFolderId, resolveRootFolderId };
}

function readCredentials(env) {
  const raw =
    env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ? Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8") : "");

  if (!raw) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.");

  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Service-account JSON must include client_email and private_key.");
  }
  return credentials;
}

function formatApiError(statusCode, body) {
  try {
    const message = String(JSON.parse(body)?.error?.message || "").trim();
    if (message) return `Google Drive request failed (${statusCode}): ${message}`;
  } catch {
    // Fall through to the generic message.
  }
  return `Google Drive request failed with status ${statusCode}.`;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

module.exports = { createDriveClient, normalizeName };
