"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Notification service for email, SMS, and WhatsApp via Twilio and Gmail SMTP
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
 *   "sms": {
 *     "enabled": true,
 *     "provider": "twilio",
 *     "accountSid": "your-account-sid",
 *     "authToken": "your-auth-token",
 *     "fromNumber": "+1234567890"
 *   },
 *   "whatsapp": {
 *     "enabled": true,
 *     "provider": "twilio",
 *     "accountSid": "your-account-sid",
 *     "authToken": "your-auth-token",
 *     "fromNumber": "whatsapp:+1234567890"
 *   },
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

  async function sendSMS(message) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.sms?.enabled || !cfg.adminPhone) return false;

    try {
      const tw = loadTwilio();
      const client = tw(cfg.sms.accountSid, cfg.sms.authToken);

      await client.messages.create({
        body: message,
        from: cfg.sms.fromNumber,
        to: cfg.adminPhone
      });

      console.log(`[Notification] SMS sent to ${cfg.adminPhone}`);
      return true;
    } catch (error) {
      console.error("[Notification] SMS send failed:", error.message);
      return false;
    }
  }

  async function sendWhatsApp(message) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.whatsapp?.enabled || !cfg.adminPhone) return false;

    try {
      const tw = loadTwilio();
      const client = tw(cfg.whatsapp.accountSid, cfg.whatsapp.authToken);

      await client.messages.create({
        body: message,
        from: cfg.whatsapp.fromNumber,
        to: `whatsapp:${cfg.adminPhone}`
      });

      console.log(`[Notification] WhatsApp sent to ${cfg.adminPhone}`);
      return true;
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
    if (!cfg.enabled) return;

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
      <p><strong>Google Drive Folder:</strong> <a href="${escapeHtml(googleDriveFolderUrl)}">Open in Drive</a></p>
      <hr/>
      <p><em>This is an automated notification from Starz Shots Gallery</em></p>
    `;

    await Promise.all([sendEmail(`Event Created: ${eventName}`, emailBody), sendSMS(shortMessage), sendWhatsApp(shortMessage)]);
  }

  /**
   * Send notifications for photo cache completion
   */
  async function notifyPhotoCacheCompleted(eventData) {
    const cfg = loadConfig();
    if (!cfg.enabled) return;

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

    await Promise.all([sendEmail(`Photo Cache Complete: ${eventName}`, emailBody), sendSMS(shortMessage), sendWhatsApp(shortMessage)]);
  }

  /**
   * Send notifications for face index completion
   */
  async function notifyFaceIndexCompleted(eventData) {
    const cfg = loadConfig();
    if (!cfg.enabled) return;

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

    await Promise.all([sendEmail(`Face Index Complete: ${eventName}`, emailBody), sendSMS(shortMessage), sendWhatsApp(shortMessage)]);
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
    sendSMS,
    sendWhatsApp,
    notifyEventCreated,
    notifyPhotoCacheCompleted,
    notifyFaceIndexCompleted
  };
}

module.exports = { createNotificationService };
