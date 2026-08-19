# Google Drive Storage POC

This isolated copy keeps the existing SpaceByte app untouched. `google-drive-server.js` reads the shared `Starz Shots` root folder, resolves an event folder by name, reads its scene subfolders, and streams images through the same gallery UI API.

## Google setup

1. Create or select a project in Google Cloud Console.
2. Enable **Google Drive API**.
3. Create a service account and a JSON key.
4. Share the `Starz Shots` root folder with the service account email as **Viewer**. Child event folders inherit access.
5. Put the `Starz Shots` folder ID from the final part of its Drive URL into `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
6. Copy `.env.example` to `.env` and set `GOOGLE_SERVICE_ACCOUNT_JSON` to the one-line JSON key. For hosted deployment, prefer `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.
7. Set each gallery's `googleDriveFolderName` to the exact event-folder name. Its immediate child folders must match `sceneFolderNames`.

For an event nested below another folder, use `googleDriveFolderPath`, for example `2026/Ayush Arjun`, instead of `googleDriveFolderName`.

The server uses only the `drive.readonly` scope. Never commit `.env` or the service-account key.

If local Node.js fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` because of a corporate HTTPS inspection proxy, set `GOOGLE_DRIVE_ALLOW_INSECURE_TLS=true` in the local `.env` as a temporary POC workaround. This disables certificate verification for Google requests. The preferred fix is to install the corporate root CA and leave this setting `false`.

## Run

```bash
npm start
```

Open `http://localhost:3002/?event=arjun-ayush`.

Open `http://localhost:3002/admin` to manage events. Set `ADMIN_TOKEN` in `.env`; the admin page uses that token to list, create, update, and browse Google Drive folders.

This POC supports metadata, scene discovery, previews, and individual downloads. Download-all is intentionally left unimplemented until the storage and access model is confirmed.