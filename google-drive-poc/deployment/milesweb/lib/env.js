"use strict";

const fs = require("fs");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
        return [key, value];
      })
  );
}

function readString(env, key, fallback = "") {
  const value = String(env[key] ?? "").trim();
  return value || fallback;
}

function readNumber(env, key, fallback) {
  const value = Number(String(env[key] ?? "").trim());
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBoolean(env, key, fallback = false) {
  const value = String(env[key] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

module.exports = { loadEnvFile, readString, readNumber, readBoolean };
