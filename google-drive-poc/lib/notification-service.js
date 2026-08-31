const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

class NotificationService {
  constructor(configPath) {
    this.config = this.loadConfig(configPath);
    this.transporter = this.setupEmailTransporter();
    this.twilio = this.setupTwilio();
  }

  loadConfig(configPath) {
    try {
      if (!fs.existsSync(configPath)) {
        console.warn(`Notifications config not found at ${configPath}`);
        return { enabled: false };
      }
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      console.error(`Failed to load notifications config: ${error.message}`);
      return { enabled: false };
    }
  }

  setupEmailTransporter() {
    if (!this.config.enabled || !this.config.email?.enabled) {
      return null;
    }

    try {
      return nodemailer.createTransport({
        service: this.config.email.service || "gmail",
        auth: this.config.email.auth
      });
    } catch (error) {
      console.error(`Failed to setup email transporter: ${error.message}`);
      return null;
    }
  }

  setupTwilio() {
    if (!this.config.enabled || !this.config.twilio?.enabled) {
      return null;
    }

    try {
      const twilio = require("twilio");
      return twilio(this.config.twilio.accountSid, this.config.twilio.authToken);
    } catch (error) {
      console.error(`Twilio not installed. Install with: npm install twilio`);
      return null;
    }
  }

  async sendEmail(subject, htmlContent, textContent) {
    if (!this.transporter || !this.config.email?.enabled) {
      console.log(`[EMAIL NOTIFICATION - NOT SENT] Subject: ${subject}`);
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.config.email.auth.user,
        to: this.config.adminEmail,
        subject,
        html: htmlContent,
        text: textContent
      });
      console.log(`[EMAIL SENT] To: ${this.config.adminEmail}, Subject: ${subject}`);
      return true;
    } catch (error) {
      console.error(`Failed to send email: ${error.message}`);
      return false;
    }
  }

  async sendSMS(message) {
    if (!this.twilio || !this.config.twilio?.enabled) {
      console.log(`[SMS NOTIFICATION - NOT SENT] Message: ${message}`);
      return false;
    }

    try {
      await this.twilio.messages.create({
        body: message,
        from: this.config.twilio.fromNumber,
        to: `+${this.config.adminPhone.replace(/[^0-9]/g, "")}`
      });
      console.log(`[SMS SENT] To: ${this.config.adminPhone}`);
      return true;
    } catch (error) {
      console.error(`Failed to send SMS: ${error.message}`);
      return false;
    }
  }

  async sendWhatsApp(message) {
    if (!this.twilio || !this.config.twilio?.enabled) {
      console.log(`[WHATSAPP NOTIFICATION - NOT SENT] Message: ${message}`);
      return false;
    }

    try {
      await this.twilio.messages.create({
        body: message,
        from: this.config.twilio.fromWhatsApp,
        to: `whatsapp:+${this.config.adminPhone.replace(/[^0-9]/g, "")}`
      });
      console.log(`[WHATSAPP SENT] To: ${this.config.adminPhone}`);
      return true;
    } catch (error) {
      console.error(`Failed to send WhatsApp: ${error.message}`);
      return false;
    }
  }

  async notifyEventCreated(event, guestCode, clientCode, galleryUrl, googleDriveFolderUrl) {
    if (!this.config.enabled) return;

    const eventSettings = this.config.notifications?.eventCreated || {};
    const eventDate = new Date(event.eventDate).toLocaleDateString("en-IN");

    const emailHtml = `
      <h2>New Event Created: ${event.eventName}</h2>
      <p><strong>Event Date:</strong> ${eventDate}</p>
      <p><strong>Client Name:</strong> ${event.clientName}</p>
      <p><strong>Google Drive Folder Path:</strong> ${event.googleDriveFolderPath || event.googleDriveFolderName}</p>
      <hr />
      <h3>Access Codes:</h3>
      <p><strong>Guest Code:</strong> <code>${guestCode}</code></p>
      <p><strong>Client Code:</strong> <code>${clientCode}</code></p>
      <hr />
      <h3>Links:</h3>
      <p><a href="${galleryUrl}" target="_blank">View Gallery</a></p>
      <p><a href="${googleDriveFolderUrl}" target="_blank">Google Drive Folder</a></p>
    `;

    const emailText = `
New Event Created: ${event.eventName}
Event Date: ${eventDate}
Client Name: ${event.clientName}

Access Codes:
Guest Code: ${guestCode}
Client Code: ${clientCode}

Links:
Gallery: ${galleryUrl}
Google Drive: ${googleDriveFolderUrl}
    `;

    const smsMessage = `New event created! ${event.eventName} - Guest Code: ${guestCode}, Client Code: ${clientCode}. View: ${galleryUrl}`;

    if (eventSettings.email) {
      await this.sendEmail(`New Event: ${event.eventName}`, emailHtml, emailText);
    }
    if (eventSettings.sms) {
      await this.sendSMS(smsMessage);
    }
    if (eventSettings.whatsapp) {
      await this.sendWhatsApp(smsMessage);
    }
  }

  async notifyPhotoCacheCompleted(event, photoCount, completionTime) {
    if (!this.config.enabled) return;

    const notifySettings = this.config.notifications?.photoCacheCompleted || {};
    const timestamp = new Date(completionTime).toLocaleString("en-IN");

    const emailHtml = `
      <h2>Photo Cache Completed</h2>
      <p><strong>Event:</strong> ${event.eventName}</p>
      <p><strong>Photos Cached:</strong> ${photoCount}</p>
      <p><strong>Completed At:</strong> ${timestamp}</p>
    `;

    const emailText = `
Photo Cache Completed
Event: ${event.eventName}
Photos Cached: ${photoCount}
Completed At: ${timestamp}
    `;

    const smsMessage = `Photo cache completed for ${event.eventName}! ${photoCount} photos cached at ${timestamp}.`;

    if (notifySettings.email) {
      await this.sendEmail(`Photo Cache Completed: ${event.eventName}`, emailHtml, emailText);
    }
    if (notifySettings.sms) {
      await this.sendSMS(smsMessage);
    }
    if (notifySettings.whatsapp) {
      await this.sendWhatsApp(smsMessage);
    }
  }

  async notifyFaceIndexCompleted(event, indexedPhotoCount, completionTime) {
    if (!this.config.enabled) return;

    const notifySettings = this.config.notifications?.faceIndexCompleted || {};
    const timestamp = new Date(completionTime).toLocaleString("en-IN");

    const emailHtml = `
      <h2>Face Index Completed</h2>
      <p><strong>Event:</strong> ${event.eventName}</p>
      <p><strong>Photos Indexed:</strong> ${indexedPhotoCount}</p>
      <p><strong>Completed At:</strong> ${timestamp}</p>
    `;

    const emailText = `
Face Index Completed
Event: ${event.eventName}
Photos Indexed: ${indexedPhotoCount}
Completed At: ${timestamp}
    `;

    const smsMessage = `Face index completed for ${event.eventName}! ${indexedPhotoCount} photos indexed at ${timestamp}.`;

    if (notifySettings.email) {
      await this.sendEmail(`Face Index Completed: ${event.eventName}`, emailHtml, emailText);
    }
    if (notifySettings.sms) {
      await this.sendSMS(smsMessage);
    }
    if (notifySettings.whatsapp) {
      await this.sendWhatsApp(smsMessage);
    }
  }
}

module.exports = NotificationService;
