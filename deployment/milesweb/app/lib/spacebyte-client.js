"use strict";

const https = require("https");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff", "gif", "bmp"]);

/**
 * Thin SpaceByte Drive client. SpaceByte lists a folder's children at
 * GET /drive/file-entries?folderId=<id>&parentId=<id>&page=<n> -> { data:[...], next_page }
 * and streams a file's bytes at GET /file-entries/download/<hash>. There is no
 * thumbnail endpoint, so low-resolution renditions are produced by the image
 * processor from the original bytes.
 */
function createSpaceByteClient({ baseUrl, token, authScheme = "Bearer", allowInsecureTls = false }) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const rejectUnauthorized = !allowInsecureTls;

  function authHeaders() {
    return token ? { Authorization: `${authScheme} ${token}` } : {};
  }

  async function fetchPage(filters, page) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (filters?.folderId) {
      params.set("folderId", String(filters.folderId));
      params.set("parentId", String(filters.parentId || filters.folderId));
    } else if (filters?.parentId) {
      params.set("parentId", String(filters.parentId));
    }
    if (filters?.path) params.set("path", String(filters.path));
    return json(`${origin}/drive/file-entries?${params}`);
  }

  async function listAll(filters) {
    const first = await fetchPage(filters, 1);
    const items = Array.isArray(first.data) ? [...first.data] : [];
    let nextPage = first.next_page ? Number(first.next_page) : null;
    const concurrency = 8;

    while (nextPage) {
      const pages = Array.from({ length: concurrency }, (_, index) => nextPage + index);
      const batch = await Promise.all(pages.map((page) => fetchPage(filters, page).catch(() => ({ data: [], next_page: null }))));

      let highest = null;
      for (const payload of batch) {
        const pageItems = Array.isArray(payload.data) ? payload.data : [];
        if (!pageItems.length) continue;
        items.push(...pageItems);
        const candidate = payload.next_page ? Number(payload.next_page) : null;
        if (Number.isFinite(candidate) && (highest === null || candidate > highest)) highest = candidate;
      }
      nextPage = highest;
    }

    return items;
  }

  async function listFolders(parentId) {
    const entries = await listAll(parentId ? { folderId: parentId } : {});
    return entries.filter((entry) => entry.type === "folder");
  }

  async function listImages(folderId) {
    const entries = await listAll({ folderId });
    return entries.filter(isImageEntry);
  }

  async function resolveEventFolder(gallery) {
    const rootId = String(gallery.spacebyteRootFolderId || "").trim();
    if (rootId) return { id: rootId, hash: String(gallery.spacebyteRootFolderHash || ""), name: "" };

    const folderName = String(gallery.spacebyteFolderName || gallery.eventName || "").trim().toLowerCase();
    if (folderName) {
      const rootEntries = await listAll({});
      const match = rootEntries.find((entry) => entry.type === "folder" && String(entry.name || "").trim().toLowerCase() === folderName);
      if (match) return match;
    }

    const folderPath = String(gallery.spacebyteFolderPath || "").trim();
    if (folderPath) {
      const entries = await listAll({ path: folderPath });
      const match = entries.find((entry) => entry.type === "folder");
      if (match) return match;
    }

    throw new Error("SpaceByte event folder was not found. Set spacebyteRootFolderId, spacebyteFolderName, or spacebyteFolderPath.");
  }

  function streamDownload(hash) {
    return stream(`${origin}/file-entries/download/${encodeURIComponent(hash)}`, authHeaders());
  }

  async function ping() {
    await json(`${origin}/drive/file-entries?page=1`);
    return true;
  }

  async function json(url) {
    const attempt = async () => {
      const { statusCode, body } = await buffered(url, authHeaders(), 20_000);
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`SpaceByte request failed with status ${statusCode}${body ? ` - ${body.slice(0, 200)}` : ""}.`);
      }
      return JSON.parse(body);
    };

    try {
      return await attempt();
    } catch (error) {
      if (error.message === "Request timed out") return attempt();
      throw error;
    }
  }

  // Classic https client (not fetch/undici) to avoid the WASM parser that OOMs under low memory limits.
  function buffered(url, headers, timeoutMs, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers, rejectUnauthorized }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const nextUrl = new URL(response.headers.location, url).toString();
          const nextHeaders = sameOrigin(url, nextUrl) ? headers : {};
          return resolve(buffered(nextUrl, nextHeaders, timeoutMs, redirectsLeft - 1));
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Request timed out")));
    });
  }

  function stream(url, headers, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers, rejectUnauthorized }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const nextUrl = new URL(response.headers.location, url).toString();
          const nextHeaders = sameOrigin(url, nextUrl) ? headers : {};
          return resolve(stream(nextUrl, nextHeaders, redirectsLeft - 1));
        }
        resolve(response);
      });
      request.on("error", reject);
    });
  }

  return { listAll, listFolders, listImages, resolveEventFolder, streamDownload, ping };
}

function isImageEntry(entry) {
  if (String(entry.type || "").toLowerCase() === "image") return true;
  if (String(entry.mime || entry.mime_type || "").startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(String(entry.extension || "").toLowerCase());
}

function entryHash(entry) {
  return String(entry.hash || "").trim();
}

function entryName(entry, fallbackIndex = 0) {
  return String(entry.name || entry.file_name || `image-${entry.id || fallbackIndex}.jpg`);
}

function entrySize(entry) {
  return Number(entry.file_size || entry.size || 0) || 0;
}

function sameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

module.exports = { createSpaceByteClient, isImageEntry, entryHash, entryName, entrySize };
