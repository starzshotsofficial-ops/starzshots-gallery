# Notifications Troubleshooting Guide

## ✅ Pre-Flight Checklist

Before running the app, ensure you have:

### 1. Configuration File Setup
```bash
# Copy the example config
cp config/notifications.example.json config/notifications.json
```

✅ File `config/notifications.json` exists and is NOT in .gitignore  
✅ `"enabled": true` is set in the config  
✅ Each channel (email, sms, whatsapp) has `"enabled": true`

### 2. Email Configuration (Gmail SMTP)

🔐 Get Gmail App Password:
1. Go to https://myaccount.google.com/
2. Click on **Security** in left menu
3. Scroll down to **App passwords**
4. Select **Mail** and **Windows Computer**
5. Copy the 16-character password (with spaces)
6. Paste into `config/notifications.json` under `email.password`

✅ `email.user`: starzshotsofficial@gmail.com  
✅ `email.password`: xxxx xxxx xxxx xxxx (16-character app password, NOT regular password)  
✅ `email.service`: "gmail"  
✅ `adminEmail`: starzshotsofficial@gmail.com  

### 3. SMS & WhatsApp Configuration (Twilio)

🔐 Get Twilio Credentials:
1. Go to https://www.twilio.com/console
2. Log in to your account
3. Copy **Account SID** and **Auth Token**
4. Go to **Phone Numbers** → **Manage Numbers**
5. Get your Twilio phone number (e.g., +1234567890)
6. For WhatsApp: Use the same number with `whatsapp:` prefix

✅ `sms.accountSid`: AC1234567890...  
✅ `sms.authToken`: your_token_here  
✅ `sms.fromNumber`: +1234567890 (Your Twilio number)  
✅ `whatsapp.accountSid`: AC1234567890... (same as SMS)  
✅ `whatsapp.authToken`: your_token_here (same as SMS)  
✅ `whatsapp.fromNumber`: whatsapp:+1234567890 (Twilio number with prefix)  
✅ `adminPhone`: +919962206330

### 4. Environment & Dependencies

```bash
# Install dependencies
npm install

# Verify nodemailer is installed
npm list nodemailer

# Verify twilio is installed
npm list twilio
```

✅ Both `nodemailer` and `twilio` appear in `npm list`  
✅ No npm errors when running `npm install`  

---

## 🐛 Debugging Steps

### Step 1: Check Server Console Logs
When you start the server, you should see:
```
[Notifications] Event created notification sent for gallery: test
[Notifications] Photo cache notification sent for gallery: test
[Notifications] Face index notification sent for gallery: test
```

**If you don't see these logs:**
- Check that `config/notifications.json` exists
- Verify `"enabled": true` in config
- Look for error logs starting with `[Notifications] Failed to send...`

### Step 2: Verify Config File Syntax
```bash
# Test if JSON is valid
node -e "console.log(JSON.parse(require('fs').readFileSync('config/notifications.json', 'utf8')))"
```

If this throws an error, your JSON has syntax issues. Common problems:
- Missing commas between fields
- Quotes around values missing
- Trailing commas at the end of objects

### Step 3: Test Individual Notification Channels

Create a test file `test-notifications.js`:

```javascript
const { createNotificationService } = require('./lib/notifications');

const notifications = createNotificationService('./config');

async function test() {
  console.log('Testing email...');
  await notifications.sendEmail('Test Email', '<h1>Test Subject</h1><p>Test body</p>');
  
  console.log('Testing SMS...');
  await notifications.sendSMS('Test SMS from Starz Shots');
  
  console.log('Testing WhatsApp...');
  await notifications.sendWhatsApp('Test WhatsApp from Starz Shots');
}

test().catch(console.error);
```

Run it:
```bash
node test-notifications.js
```

Watch for error messages for each channel.

### Step 4: Common Issues & Fixes

| Issue | Cause | Solution |
|-------|-------|----------|
| "nodemailer not installed" | Missing dependency | Run `npm install` |
| "twilio not installed" | Missing dependency | Run `npm install` |
| "Invalid admin token" | Config file not found | Create `config/notifications.json` from example |
| Gmail auth fails | Wrong password | Use app password, not regular Gmail password |
| Gmail auth fails | 2FA enabled | Create app-specific password in Gmail settings |
| Twilio fails: "Invalid phone" | Wrong phone format | Use international format: +1234567890 |
| Twilio fails: "No credit" | Trial credit expired | Add payment method to Twilio account |
| WhatsApp fails | Number not registered | Register WhatsApp on Twilio dashboard first |

### Step 5: Monitor Notifications in Real-Time

Add these debug lines to `lib/notifications.js` at the start of each function:

```javascript
async function sendEmail(subject, body) {
  console.log(`[DEBUG] sendEmail called with subject: "${subject}"`);
  console.log(`[DEBUG] Email config:`, cfg.email);
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.email?.enabled || !cfg.adminEmail) {
    console.log(`[DEBUG] Email disabled or config missing`);
    return false;
  }
  // ... rest of function
}
```

---

## ✅ Verification Checklist After Setup

- [ ] `config/notifications.json` file exists
- [ ] `"enabled": true` in main config
- [ ] All three channels have `"enabled": true`
- [ ] Gmail app password is set (16-character)
- [ ] Twilio Account SID is set
- [ ] Twilio Auth Token is set
- [ ] Twilio phone number format is correct (+1234567890)
- [ ] Admin email is correct (starzshotsofficial@gmail.com)
- [ ] Admin phone is correct (+919962206330)
- [ ] `npm install` completed without errors
- [ ] Server starts without errors
- [ ] Log shows "[Notifications]" messages when creating events

---

## 📱 Test Event Creation

1. Go to admin panel: `http://localhost:3001/admin`
2. Enter your admin token
3. Create a new event
4. Check:
   - **Server console** for notification logs
   - **Email**: starzshotsofficial@gmail.com (check spam folder)
   - **SMS/WhatsApp**: Look for messages on +919962206330

---

## 🔄 Cache & Face Index Testing

These notifications will be sent when:
- **Photo cache** completes (automatic, usually 5-30 minutes after event creation)
- **Face index** completes (if face recognition is enabled)

To trigger manually:
1. Go to admin panel
2. Find the event
3. Click **Rebuild cache** button
4. Watch server console for notifications

---

## ⚠️ Important Notes

- **Notifications are non-blocking**: They won't stop the API from responding
- **Errors are logged but silent**: Failed notifications won't crash the server
- **Twilio has rate limits**: Free tier allows limited messages; upgrade if needed
- **Gmail has daily limits**: Default 300/day for free accounts
- **Phone number format**: Must include country code (+1, +91, etc.)

---

## 🆘 Still Not Working?

If notifications still aren't sending after checking everything above:

1. Check browser DevTools Console (F12) for any client-side errors
2. Check server terminal for any error messages
3. Verify the event was actually created (check admin panel)
4. Manually test with the `test-notifications.js` script
5. Check Twilio & Gmail account status & quotas

---

**Last Updated**: August 31, 2026  
**Status**: Implementation complete - Follow checklist above for successful setup
