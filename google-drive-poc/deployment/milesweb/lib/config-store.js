"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PERMISSIONS = {
  client: { canFavorite: true, canDownloadSingle: true, canDownloadAll: true },
  guest: { canFavorite: true, canDownloadSingle: true, canDownloadAll: false }
};

function createConfigStore(filePath) {
  let data = readConfig(filePath);

  function list() {
    return data.galleries || [];
  }

  function find(slug) {
    return list().find((gallery) => gallery.slug === slug) || null;
  }

  function add(gallery) {
    data.galleries.push(gallery);
    save();
    return gallery;
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function reload() {
    data = readConfig(filePath);
  }

  return { list, find, add, save, reload };
}

function readConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { galleries: [] };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { galleries: Array.isArray(parsed.galleries) ? parsed.galleries : [] };
  } catch {
    return { galleries: [] };
  }
}

function createAccessCodes(clientCode, guestCode) {
  return [
    { label: "Client", code: clientCode, role: "client", permissions: { ...DEFAULT_PERMISSIONS.client } },
    { label: "Guest", code: guestCode, role: "guest", permissions: { ...DEFAULT_PERMISSIONS.guest } }
  ];
}

function getAccessCode(gallery, role) {
  return (gallery.accessCodes || []).find((entry) => entry.role === role)?.code || "";
}

function setAccessCode(gallery, role, code) {
  const entry = (gallery.accessCodes || []).find((item) => item.role === role);
  if (entry) entry.code = code;
}

function matchAccessCode(gallery, code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return null;
  return (gallery.accessCodes || []).find((entry) => String(entry.code || "").trim().toLowerCase() === normalized) || null;
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceSignature(gallery) {
  return JSON.stringify({
    folderName: gallery.googleDriveFolderName || gallery.eventName || "",
    folderPath: gallery.googleDriveFolderPath || "",
    scenes: gallery.sceneFolderNames || []
  });
}

module.exports = { createConfigStore, createAccessCodes, getAccessCode, setAccessCode, matchAccessCode, toSlug, sourceSignature };
