# Starz Shots Gallery

A lightweight local prototype for a Pic-Time-style photography client gallery.

## What is included

- Event name, event date, and client name
- Access-code screen
- Separate client and guest access
- Per-person favorites by email or mobile number
- Scene/folder navigation
- Favorite counts on each scene/folder tab
- Masonry-style gallery grid
- Fullscreen image viewer
- Favorites stored in the browser with `localStorage`
- Photo download for clients and guests
- Full-gallery download links for clients only
- Sample gallery data that mirrors a SpaceByte folder structure

## Run locally with sample data

You can open `index.html` directly in your browser for the quickest test.

The sample access code is:

```text
1234
```

Client test identities:

```text
rahul@example.com
priya@example.com
father@example.com
```

Guest test access:

```text
Any valid email or mobile number
Access code: guest
```

Client access can favorite, download single photos, and download a full-gallery links file. Guest access can favorite and download single photos only. Favorites are separated by gallery, role, and email/mobile number.

## Connect to SpaceByte locally

Create a local `.env` file from `.env.example`:

```text
SPACEBYTE_BASE_URL=https://spacebyte.in/api/v1
SPACEBYTE_TOKEN=your_spacebyte_access_token_here
PORT=8080
```

Then edit:

```text
config/galleries.json
```

Set either `spacebyteFolderPath` or `spacebyteRootFolderId` for your gallery. Keep your client and guest access rules in the same file.

Run the local backend:

```powershell
node server.js
```

Then open:

```text
http://localhost:8080
```

Admin setup page:

```text
http://localhost:8080/admin.html
```

Set `ADMIN_TOKEN` in `.env` and enter the same value in the admin page to:

- list existing events
- create new events in `config/galleries.json`
- map the new event to `spacebyteRootFolderId` or `spacebyteFolderPath`

The frontend will call:

```text
GET /api/galleries/rahul-priya-wedding
```

The backend will call SpaceByte using your private token.

## Static local server

If Python is installed:

```powershell
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## SpaceByte integration plan

See the detailed endpoint mapping in:

```text
docs/spacebyte-integration.md
```

When opened directly from disk, the local prototype uses this fallback file:

```text
data/gallery.sample.json
```

The important fields are:

```json
{
  "eventName": "Rahul & Priya Wedding",
  "eventDate": "2026-02-14",
  "clientName": "Rahul Sharma and Priya Nair",
  "spacebyteFolderPath": "weddings/rahul-priya-2026",
  "scenes": [
    {
      "name": "Ceremony",
      "spacebytePath": "weddings/rahul-priya-2026/ceremony",
      "images": []
    }
  ]
}
```

When opened through `node server.js`, `app.js` uses this backend endpoint:

```text
GET /api/galleries/:slug
```

That backend endpoint should:

- Keep the SpaceByte API key private
- Call SpaceByte `GET /drive/file-entries`
- Group files into scenes based on folder names
- Return image URLs or download URLs from `GET /file-entries/download/{hashes}`
- Save favorites per gallery and per viewer identity
- Enforce client-only full-gallery downloads

For a lightweight hosted version, use a static frontend plus a tiny serverless function if SpaceByte files are private. If SpaceByte provides public share/CDN URLs, the whole gallery can remain static.
