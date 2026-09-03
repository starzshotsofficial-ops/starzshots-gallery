"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Notification service for email and WhatsApp via Gmail SMTP and CallMeBot/Twilio
 * Config file location: config/notifications.json
 * Example config structure:
 * {
 *   "enabled": true,
 *   "email": {
 *     "enabled": true,
 *     "service": "gmail",
 *     "user": "your-email@gmail.com",
 *     "password": "your-app-password"
 *   },
 *   "whatsapp": {
 *     "enabled": true,
 *     "provider": "callmebot",
 *     "apikey": "your-callmebot-apikey"
 *   },
 *   // Or use Twilio instead: { "enabled": true, "provider": "twilio", "accountSid": "...", "authToken": "...", "fromNumber": "whatsapp:+1234567890" }
 *   "adminPhone": "+919962206330",
 *   "adminEmail": "starzshotsofficial@gmail.com"
 * }
 */

let nodemailer = null;
let twilio = null;

// Lazy load dependencies only if needed
function loadNodemailer() {
  if (!nodemailer) {
    try {
      nodemailer = require("nodemailer");
    } catch {
      throw new Error("nodemailer not installed. Run: npm install nodemailer");
    }
  }
  return nodemailer;
}

function loadTwilio() {
  if (!twilio) {
    try {
      twilio = require("twilio");
    } catch {
      throw new Error("twilio not installed. Run: npm install twilio");
    }
  }
  return twilio;
}

function createNotificationService(configDir) {
  let config = null;

  function loadConfig() {
    if (config) return config;
    try {
      const filePath = path.join(configDir, "notifications.json");
      if (!fs.existsSync(filePath)) {
        console.warn(`Notifications config not found at ${filePath}. Notifications are disabled.`);
        return { enabled: false };
      }
      config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return config;
    } catch (error) {
      console.error("Error loading notifications config:", error);
      return { enabled: false };
    }
  }

  async function sendEmail(subject, body) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.email?.enabled || !cfg.adminEmail) return false;

    try {
      const nm = loadNodemailer();
      const transporter = nm.createTransport({
        service: cfg.email.service || "gmail",
        auth: {
          user: cfg.email.user,
          pass: cfg.email.password
        }
      });

      await transporter.sendMail({
        from: cfg.email.user,
        to: cfg.adminEmail,
        subject,
        html: body
      });

      console.log(`[Notification] Email sent to ${cfg.adminEmail}`);
      return true;
    } catch (error) {
      console.error("[Notification] Email send failed:", error.message);
      return false;
    }
  }

  // Free WhatsApp send via CallMeBot (https://www.callmebot.com/blog/free-api-whatsapp-messages/).
  async function sendWhatsAppViaCallMeBot(message, cfg) {
    const phone = cfg.whatsapp.phone || cfg.adminPhone;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(cfg.whatsapp.apikey)}`;
    const response = await fetch(url);
    const body = await response.text();
    if (!response.ok || /error/i.test(body)) throw new Error(body || `HTTP ${response.status}`);
    console.log(`[Notification] WhatsApp (CallMeBot) sent to ${phone}`);
    return true;
  }

  async function sendWhatsAppViaTwilio(message, cfg) {
    const tw = loadTwilio();
    const client = tw(cfg.whatsapp.accountSid, cfg.whatsapp.authToken);

    await client.messages.create({
      body: message,
      from: cfg.whatsapp.fromNumber,
      to: `whatsapp:${cfg.adminPhone}`
    });

    console.log(`[Notification] WhatsApp (Twilio) sent to ${cfg.adminPhone}`);
    return true;
  }

  async function sendWhatsApp(message) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.whatsapp?.enabled || !cfg.adminPhone) return false;

    try {
      return cfg.whatsapp.provider === "callmebot" ? await sendWhatsAppViaCallMeBot(message, cfg) : await sendWhatsAppViaTwilio(message, cfg);
    } catch (error) {
      console.error("[Notification] WhatsApp send failed:", error.message);
      return false;
    }
  }

  /**
   * Send notifications for event creation
   */
  async function notifyEventCreated(eventData) {
    const cfg = loadConfig();
    if (!cfg.enabled) return false;

    const eventName = eventData.eventName || "Unknown Event";
    const eventDate = eventData.eventDate || "N/A";
    const clientCode = eventData.clientCode || "N/A";
    const guestCode = eventData.guestCode || "N/A";
    const galleryUrl = eventData.galleryUrl || "N/A";
    const googleDriveFolderUrl = eventData.googleDriveFolderUrl || "N/A";

    const shortMessage = `Event Created: ${eventName} (${eventDate})\nClient: ${clientCode} | Guest: ${guestCode}\nGallery: ${galleryUrl}`;

    const emailBody = `
      <h2>📸 Event Created Successfully</h2>
      <p><strong>Event Name:</strong> ${escapeHtml(eventName)}</p>
      <p><strong>Event Date:</strong> ${escapeHtml(eventDate)}</p>
      <p><strong>Client Code:</strong> <code>${escapeHtml(clientCode)}</code></p>
      <p><strong>Guest Code:</strong> <code>${escapeHtml(guestCode)}</code></p>
      <p><strong>Gallery URL:</strong> <a href="${escapeHtml(galleryUrl)}">${escapeHtml(galleryUrl)}</a></p>
      <p><strong>Google Drive URL (bulk download):</strong> <a href="${escapeHtml(googleDriveFolderUrl)}">${escapeHtml(googleDriveFolderUrl)}</a></p>
      <hr/>
      <p><em>This is an automated notification from Starz Shots Gallery</em></p>
    `;

    return Promise.all([sendEmail(`Event Created: ${eventName}`, emailBody), sendWhatsApp(shortMessage)]);
  }

  /**
   * Send notifications for photo cache completion
   */
  async function notifyPhotoCacheCompleted(eventData) {
    const cfg = loadConfig();
    if (!cfg.enabled) return false;

    const eventName = eventData.eventName || "Unknown Event";
    const photoCount = eventData.photoCount || 0;
    const completedAt = new Date().toLocaleString();

    const shortMessage = `✅ Photo Cache Complete: ${eventName}\nPhotos: ${photoCount}\nTime: ${completedAt}`;

    const emailBody = `
      <h2>✅ Photo Cache Completed</h2>
      <p><strong>Event:</strong> ${escapeHtml(eventName)}</p>
      <p><strong>Photos Cached:</strong> ${photoCount}</p>
      <p><strong>Completion Time:</strong> ${completedAt}</p>
      <hr/>
      <p><em>All photos are now ready for viewing.</em></p>
    `;

    return Promise.all([sendEmail(`Photo Cache Complete: ${eventName}`, emailBody), sendWhatsApp(shortMessage)]);
  }

  /**
   * Send notifications for face index completion
   */
  async function notifyFaceIndexCompleted(eventData) {
    const cfg = loadConfig();
    if (!cfg.enabled) return false;

    const eventName = eventData.eventName || "Unknown Event";
    const faceCount = eventData.faceCount || 0;
    const completedAt = new Date().toLocaleString();

    const shortMessage = `👤 Face Index Complete: ${eventName}\nFaces: ${faceCount}\nTime: ${completedAt}`;

    const emailBody = `
      <h2>👤 Face Index Completed</h2>
      <p><strong>Event:</strong> ${escapeHtml(eventName)}</p>
      <p><strong>Faces Indexed:</strong> ${faceCount}</p>
      <p><strong>Completion Time:</strong> ${completedAt}</p>
      <p><em>Guests can now use the "Find My Photos" feature.</em></p>
      <hr/>
    `;

    return Promise.all([sendEmail(`Face Index Complete: ${eventName}`, emailBody), sendWhatsApp(shortMessage)]);
  }

  function escapeHtml(text) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return String(text || "").replace(/[&<>"']/g, (m) => map[m]);
  }

  return {
    sendEmail,
    sendWhatsApp,
    notifyEventCreated,
    notifyPhotoCacheCompleted,
    notifyFaceIndexCompleted
  };
}

module.exports = { createNotificationService };
