# Quick Start Guide - New Features Setup

This guide will help you quickly set up and test the three new features.

## Prerequisites
- Node.js 18+ installed
- Gmail account (for email notifications)
- Twilio account (for SMS/WhatsApp notifications)

---

## Step 1: Install Dependencies

```bash
cd google-drive-poc
npm install nodemailer twilio
```

---

## Step 2: Configure Email Notifications (Gmail)

### Get Gmail App Password:
1. Go to https://myaccount.google.com
2. Click "Security" in the left menu
3. Scroll down to "App passwords" (requires 2FA enabled)
4. Select "Mail" and "Windows Computer"
5. Copy the 16-character password

### Update notifications.json:
```json
{
  "enabled": true,
  "adminEmail": "starzshotsofficial@gmail.com",
  "adminPhone": "9962206330",
  "email": {
    "enabled": true,
    "service": "gmail",
    "auth": {
      "user": "starzshotsofficial@gmail.com",
      "pass": "your-16-char-app-password"
    }
  },
  ...rest of config
}
```

---

## Step 3: Configure Twilio (SMS & WhatsApp)

### Get Twilio Credentials:
1. Sign up at https://www.twilio.com
2. Go to Console > Account SID (copy it)
3. Go to Console > Auth Token (copy it)
4. Get a Twilio phone number for SMS
5. For WhatsApp: Use the Twilio WhatsApp sandbox number

### Update notifications.json:
```json
"twilio": {
  "enabled": true,
  "accountSid": "ACxxxxxxxxxxxxxxxxxxxx",
  "authToken": "your-auth-token",
  "fromNumber": "+1234567890",
  "fromWhatsApp": "whatsapp:+14155238886"
}
```

---

## Step 4: Set Environment Variables

In `.env` file (or system environment):
```
BASE_URL=http://localhost:3002
```

For production:
```
BASE_URL=https://www.starzshots.co.in
```

---

## Step 5: Restart the Server

```bash
npm start
```

You should see: `Google Drive POC running at http://localhost:3002`

---

## Testing Feature 1: Cover Picture

### Test Steps:
1. Open http://localhost:3002/admin
2. Create a new event (or use existing one)
3. Open http://localhost:3002/?event=test-slug
4. Enter your name and client code
5. Look for the crown icon (👑) on each photo
6. Click the crown on any photo
7. ✅ Verify the cover image updates in the hero section

---

## Testing Feature 2: Photo Hide

### Test Steps:
1. Logged in as client (from Feature 1 test)
2. Look for the eye icon (👁️) on photos
3. Click eye icon on a photo
4. ✅ Photo tile shows darker background (hidden state)
5. Refresh page - hidden state persists
6. Click eye icon again to unhide
7. Open gallery as guest (with guest code)
8. ✅ Verify hidden photos don't appear in guest view

---

## Testing Feature 3: Notifications

### Test Steps:
1. Go to http://localhost:3002/admin
2. Enter your ADMIN_TOKEN
3. Create a new event
4. ✅ Check your Gmail inbox for notification email
5. ✅ Check SMS on phone (if Twilio SMS enabled)
6. ✅ Check WhatsApp (if Twilio WhatsApp enabled)

### Expected Email Content:
- Event name and date
- Guest and Client codes
- Gallery URL
- Google Drive folder link

### Expected SMS/WhatsApp:
- Event name with codes
- Link to gallery

---

## Troubleshooting

### No Notifications Received?
1. Check `config/notifications.json` exists and is valid JSON
2. Check server logs for error messages
3. Verify credentials are correct:
   - Gmail: Test with standalone SMTP client
   - Twilio: Check balance (free tier has limits)

### Crown Icon Not Showing?
1. Make sure you're logged in as **client**
2. Check browser developer tools (F12) for JavaScript errors
3. Verify `app.js` was updated correctly

### Photos Not Hiding?
1. Make sure you're logged in as **client**
2. Click eye icon to toggle hide state
3. Refresh page - should persist (stored in localStorage)
4. Clear localStorage if it's not working: Open DevTools > Application > LocalStorage > Delete all

### Can't Create Admin Event?
1. Make sure ADMIN_TOKEN is set in `.env`
2. Make sure GOOGLE_DRIVE_ROOT_FOLDER_ID is set
3. Check Google Drive folder path is correct

---

## Manual Trigger for Photo Cache & Face Index Notifications

To send notifications when these processes complete, add this code to your cache/index process:

```javascript
const NotificationService = require('./lib/notification-service');
const notifyService = new NotificationService('./config/notifications.json');

// After photo caching completes:
await notifyService.notifyPhotoCacheCompleted(gallery, photoCount, Date.now());

// After face indexing completes:
await notifyService.notifyFaceIndexCompleted(gallery, indexedCount, Date.now());
```

---

## Files to Review

- **Features Documentation:** `FEATURES.md`
- **Notification Service:** `lib/notification-service.js`
- **Configuration:** `config/notifications.json`
- **Client Code:** `app.js` (search for "crown", "hide")
- **Server Code:** `google-drive-server.js` (search for "set-cover", "toggle-hide")

---

## Next Steps

1. ✅ Install and configure notifications
2. ✅ Test all three features
3. Optional: Customize email templates in `notification-service.js`
4. Optional: Add more notification channels (Slack, Teams, etc.)
5. Deploy to production with proper credentials

---

## Security Reminders

⚠️ **IMPORTANT:**
- Never commit `config/notifications.json` with real credentials to Git
- Use environment variables for production credentials
- Keep ADMIN_TOKEN secure (use strong random string)
- Rotate credentials periodically
- Monitor Twilio usage to avoid unexpected charges

---

## Support

For issues or questions:
1. Check error messages in server console
2. Review `FEATURES.md` for detailed documentation
3. Check Twilio and Gmail documentation for API changes
4. Verify all credentials are correct (common mistake!)
