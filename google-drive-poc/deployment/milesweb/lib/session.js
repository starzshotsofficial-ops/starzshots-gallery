"use strict";

const crypto = require("crypto");

const COOKIE_NAME = "starz_gallery";

function createSessionManager({ secret, ttlHours, basePath, secureCookies }) {
  const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;

  function issue(payload) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
    return `${body}.${sign(body)}`;
  }

  function verify(token) {
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature) return null;

    const expected = sign(body);
    if (!timingSafeEqual(signature, expected)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload.exp > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }

  function read(request, slug) {
    const session = verify(parseCookies(request.headers.cookie)[COOKIE_NAME]);
    return session && session.slug === slug ? session : null;
  }

  function cookieHeader(payload, options = {}) {
    const attributes = [
      `${COOKIE_NAME}=${issue(payload)}`,
      `Path=${basePath || "/"}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(ttlMs / 1000)}`
    ];
    // Browsers drop a Secure cookie sent over plain HTTP, so match the flag to the actual request.
    const secure = typeof options.secure === "boolean" ? options.secure : secureCookies;
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  function sign(body) {
    return crypto.createHmac("sha256", secret).update(body).digest("base64url");
  }

  return { read, cookieHeader };
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1 ? [part, ""] : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = { createSessionManager, timingSafeEqual };
