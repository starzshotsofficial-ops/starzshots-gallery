"use strict";

const fs = require("fs");
const path = require("path");

const STATIC_FILES = {
  "index.html": "text/html; charset=utf-8",
  "admin.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "admin.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "styles.extra.css": "text/css; charset=utf-8"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function serveStatic(rootDir, requestPath, response) {
  const relative = requestPath === "/" || requestPath === "" ? "index.html" : requestPath.replace(/^\/+/, "");
  const contentType = STATIC_FILES[relative];

  if (!contentType) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const filePath = path.join(rootDir, relative);
  if (!fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
  fs.createReadStream(filePath).pipe(response);
}

function readJsonBody(request, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limitBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

module.exports = { sendJson, serveStatic, readJsonBody, SECURITY_HEADERS };
