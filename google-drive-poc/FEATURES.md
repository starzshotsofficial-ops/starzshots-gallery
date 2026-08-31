# New Features Implementation Guide

This document explains the three new features added to the Starz Shots Gallery:

## Feature 1: Cover Picture Selection with Crown Icon

### Description
Clients can now set any photo as the gallery cover picture by clicking a crown icon (👑) on each photo.

### How to Use
1. Log in to the gallery as a client (using the client access code)
2. In the gallery grid or lightbox, locate the crown icon (👑) on each photo
3. Click the crown icon to set that photo as the cover picture
4. The cover image will update immediately in the gallery hero section
5. The cover setting persists and will be shown to all users (clients and guests)

### Technical Details
- Crown icon is visible only to clients in the photo tiles
- Also available in the lightbox view
- Cover image reference is stored in `galleries.json`
- API endpoint: `POST /api/galleries/{slug}/set-cover`
- When a cover is set, it's stored as a file reference in the database

---

## Feature 2: Photo Hide Feature

### Description
Clients can hide sensitive photos from the guest view while keeping them in the client view.

### How to Use
1. Log in to the gallery as a client
2. Look for the eye icon (👁️) on each photo (in gallery grid or lightbox)
3. Click the eye icon to hide/unhide the photo
4. Hidden photos will NOT appear in the guest gallery view
5. Clients can always see all photos, including hidden ones
6. Hidden photos are visible only to the client who hid them (per viewer basis)

### Technical Details
- Hide feature is client-only (guests cannot see or use this feature)
- Hidden photos are stored per viewer in separate JSON files: `data/{slug}-hidden-photos.json`
- The data structure: `{ "viewerId": ["photoId1", "photoId2", ...] }`
- Guests automatically see filtered gallery without hidden photos
- Clients see all photos but with hidden status tracked
- API endpoint: `POST /api/galleries/{slug}/toggle-hide-photo`
- Eye icon color changes when a photo is hidden (darker background)

---

## Feature 3: Notifications (Email, WhatsApp, SMS)

### Description
The admin/photographer receives notifications via email, SMS, and WhatsApp when:
1. A new event is created
2. Photo cache completion (when photos are ready)
3. Face index completion (when facial recognition is done)

### Setup Instructions

#### Step 1: Install Optional Dependencies
```bash
npm install nodemailer twilio
```

#### Step 2: Configure Notifications
Edit `config/notifications.json` and fill in:

**Gmail Setup:**
1. Go to https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Generate and copy the 16-character password
4. Add to notifications.json:
```json
"email": {
  "enabled": true,
  "service": "gmail",
  "auth": {
    "user": "starzshotsofficial@gmail.com",
    "pass": "generated-16-char-password"
  }
}
```

**Twilio Setup:**
1. Create account at https://www.twilio.com
2. Go to Console > Account SID and Auth Token
3. Get your Twilio phone number (for SMS)
4. Get WhatsApp sandbox number or enable WhatsApp messaging
5. Add to notifications.json:
```json
"twilio": {
  "enabled": true,
  "accountSid": "your-account-sid",
  "authToken": "your-auth-token",
  "fromNumber": "+1234567890",
  "fromWhatsApp": "whatsapp:+14155238886"
}
```

#### Step 3: Set Base URL (for production)
In `.env`, add:
```
BASE_URL=https://www.starzshots.co.in
```

This ensures the gallery links in notifications point to the correct URL.

### Notification Types

#### Event Created Notification
Sent when an event is created from the admin panel. Includes:
- Event name and date
- Client name
- Guest and Client access codes
- Gallery URL
- Google Drive folder link

#### Photo Cache Completed
Can be triggered manually. Includes:
- Event name
- Number of photos cached
- Completion timestamp

#### Face Index Completed
Can be triggered manually. Includes:
- Event name
- Number of photos indexed
- Completion timestamp

### How Notifications Are Triggered

**Event Creation:**
- Automatically sent when an event is created via admin panel

**Photo Cache & Face Index Completion:**
These notifications need to be triggered manually from your application code when these processes complete. Example:

```javascript
// In your photo caching or face indexing code
await notificationService.notifyPhotoCacheCompleted(event, photoCount, Date.now());
await notificationService.notifyFaceIndexCompleted(event, indexedCount, Date.now());
```

### Notification Configuration

In `config/notifications.json`, you can enable/disable each channel per notification type:

```json
"notifications": {
  "eventCreated": {
    "email": true,
    "sms": true,
    "whatsapp": true
  },
  "photoCacheCompleted": {
    "email": true,
    "sms": true,
    "whatsapp": true
  },
  "faceIndexCompleted": {
    "email": true,
    "sms": true,
    "whatsapp": true
  }
}
```

### Troubleshooting

**Gmail Authentication Failed:**
- Make sure you used an app-specific password (not your Google password)
- Enable "Less secure app access" is NOT needed with app passwords

**Twilio Not Working:**
- Verify Account SID and Auth Token are correct
- For SMS: Ensure phone number includes country code (e.g., +919962206330 for India)
- For WhatsApp: Make sure recipient has added WhatsApp sandbox number first
- Run `npm install twilio` if you get "module not found" error

**No Notifications Being Sent:**
- Check that `config/notifications.json` exists and is valid JSON
- Verify `"enabled": true` is set at the root level
- Check console logs for specific error messages

### Email Service Providers

If you prefer not to use Gmail, you can configure other email providers in nodemailer. Common options:

**SendGrid:**
```json
"email": {
  "service": "SendGrid",
  "auth": {
    "user": "apikey",
    "pass": "your-sendgrid-api-key"
  }
}
```

**AWS SES, Mailgun, etc.** - Refer to Nodemailer documentation for setup

---

## API Endpoints Summary

### Cover Picture
- **Endpoint:** `POST /api/galleries/{slug}/set-cover`
- **Body:** `{ "photoId": "google-drive-file-id", "filename": "photo.jpg" }`
- **Response:** `{ "ok": true, "coverImage": "/api/files/..." }`

### Hide Photo
- **Endpoint:** `POST /api/galleries/{slug}/toggle-hide-photo`
- **Body:** `{ "photoId": "google-drive-file-id", "viewerId": "normalized-viewer-id" }`
- **Response:** `{ "ok": true, "isHidden": true/false }`

---

## File Structure

```
google-drive-poc/
├── config/
│   ├── galleries.json              # Event configuration
│   └── notifications.json          # Notification settings (NEW)
├── data/
│   ├── {slug}-hidden-photos.json   # Per-event hidden photo list (NEW)
│   └── ...
├── lib/
│   └── notification-service.js     # Notification handler (NEW)
├── index.html                       # Gallery UI
├── admin.html                       # Admin panel
├── app.js                          # Client-side logic (UPDATED)
├── admin.js                        # Admin logic
├── styles.css                      # Styling (UPDATED)
└── google-drive-server.js          # Server (UPDATED)
```

---

## Testing

### Test Feature 1 (Cover Picture)
1. Create an event in admin panel
2. Log in as client
3. Click the crown icon on any photo
4. Verify cover image updates immediately

### Test Feature 2 (Hide Photo)
1. Log in as client
2. Click the eye icon on any photo to hide it
3. Refresh the page (hidden state persists via localStorage)
4. Log in as guest
5. Verify hidden photos don't appear in guest view

### Test Feature 3 (Notifications)
1. Ensure `config/notifications.json` is properly configured
2. Create an event via admin panel
3. Check email, SMS, and WhatsApp for notifications
4. Verify all required information is included

---

## Security Notes

1. **Email Passwords:** Never commit email/API credentials to git. Use environment variables or config files in .gitignore
2. **Hidden Photos:** Hidden photos are still accessible via direct file ID if known. For true privacy, consider deleting photos instead
3. **Admin Panel:** Protect the admin panel with a strong ADMIN_TOKEN
4. **Viewer ID:** Viewer IDs are normalized and case-insensitive for consistency

---

## Future Enhancements

Potential improvements:
- Bulk hide/unhide photos
- Auto-hide sensitive photos using AI detection
- Notification delivery status tracking
- Custom email templates
- More SMS providers (AWS SNS, Nexmo, etc.)
- Webhook support for external integrations
