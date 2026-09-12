"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PERMISSIONS = {
  client: { canFavorite: true, canDownloadSingle: true, canDownloadAll: true },
  guest: { canFavorite: true, canDownloadSingle: true, canDownloadAll: false },
  // Friends can only use face search. Matched photos are displayed by that page,
  // but they cannot browse, favourite, or download the event gallery.
  friend: { canFavorite: false, canDownloadSingle: false, canDownloadAll: false }
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

  function remove(slug) {
    const before = data.galleries.length;
    data.galleries = data.galleries.filter((gallery) => gallery.slug !== slug);
    const removed = data.galleries.length !== before;
    if (removed) save();
    return removed;
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function reload() {
    data = readConfig(filePath);
  }

  return { list, find, add, remove, save, reload };
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
    { label: "Guest", code: guestCode, role: "guest", permissions: { ...DEFAULT_PERMISSIONS.guest } },
    { label: "Friend", code: "friend", role: "friend", permissions: { ...DEFAULT_PERMISSIONS.friend } }
  ];
}

function getAccessCode(gallery, role) {
  const configured = (gallery.accessCodes || []).find((entry) => entry.role === role)?.code;
  // Existing events created before Friend access was introduced should be able
  // to use the same default immediately; saving the event persists the entry.
  return configured || (role === "friend" ? "friend" : "");
}

function setAccessCode(gallery, role, code) {
  gallery.accessCodes = Array.isArray(gallery.accessCodes) ? gallery.accessCodes : [];
  // Friend is a real access profile, not an optional blank field. This also
  // repairs older event records if Admin saves a row with the field cleared.
  const normalizedCode = String(code || "").trim() || (role === "friend" ? "friend" : "");
  const entry = gallery.accessCodes.find((item) => item.role === role);
  if (entry) {
    entry.code = normalizedCode;
    entry.label = entry.label || role[0].toUpperCase() + role.slice(1);
    entry.permissions = entry.permissions || { ...(DEFAULT_PERMISSIONS[role] || {}) };
    return;
  }

  if (DEFAULT_PERMISSIONS[role]) {
    gallery.accessCodes.push({
      label: role[0].toUpperCase() + role.slice(1),
      code: normalizedCode,
      role,
      permissions: { ...DEFAULT_PERMISSIONS[role] }
    });
  }
}

function matchAccessCode(gallery, code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return null;
  const matched = (gallery.accessCodes || []).find((entry) => String(entry.code || "").trim().toLowerCase() === normalized);
  if (matched) return matched;

  // Backward compatibility for events saved before the Friend profile existed.
  const friendEntry = (gallery.accessCodes || []).find((entry) => entry.role === "friend");
  if (normalized === "friend" && !String(friendEntry?.code || "").trim()) {
    return { label: "Friend", code: "friend", role: "friend", permissions: { ...DEFAULT_PERMISSIONS.friend } };
  }
  return null;
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
