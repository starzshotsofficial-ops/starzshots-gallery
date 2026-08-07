# SpaceByte Integration Notes

SpaceByte API base URL:

```text
https://spacebyte.in/api/v1
```

Every backend request to SpaceByte should include:

```text
Authorization: Bearer <token>
```

Do not put this token in `index.html`, `app.js`, or any browser-side file.

## Relevant SpaceByte Endpoints

For this gallery app, the important endpoints from the API document are:

```text
POST /auth/login
GET  /drive/file-entries
GET  /file-entries/download/{hashes}
POST /file-entries/{entryId}/shareable-link
GET  /file-entries/{entryId}/shareable-link
```

Useful but not required for the first gallery viewer:

```text
POST   /uploads
POST   /s3/simple/presign
POST   /s3/multipart/create
POST   /s3/multipart/batch-sign-part-urls
POST   /s3/multipart/get-uploaded-parts
POST   /s3/multipart/complete
POST   /s3/multipart/abort
POST   /s3/entries
POST   /folders
POST   /file-entries/move
POST   /file-entries/duplicate
POST   /file-entries/restore
POST   /file-entries/star
POST   /file-entries/unstar
DELETE /file-entries
```

## Recommended Lightweight Architecture

Keep the frontend static and add a tiny backend or serverless function.

This repo now includes a local version of that backend:

```text
server.js
config/galleries.json
.env.example
```

The frontend calls your backend:

```text
GET /api/galleries/:slug
GET /api/galleries/:slug/download
GET /api/images/:entryId/download
```

Your backend calls SpaceByte:

```text
GET /drive/file-entries
GET /file-entries/download/{hashes}
```

This keeps the SpaceByte token private and lets you enforce:

- Client-only full-gallery downloads
- Guest single-photo downloads only
- Per-viewer favorites
- Gallery access rules

## Mapping SpaceByte Folders To Gallery Scenes

Use one SpaceByte root folder for each client gallery:

```text
weddings/rahul-priya-2026
```

Each direct subfolder becomes a scene:

```text
weddings/rahul-priya-2026/ceremony
weddings/rahul-priya-2026/portraits
weddings/rahul-priya-2026/reception
```

Each image file inside a scene maps into the gallery format:

```json
{
  "id": "spacebyte-entry-id",
  "filename": "ceremony-001.jpg",
  "url": "/api/images/spacebyte-entry-id/download",
  "thumbnailUrl": "/api/images/spacebyte-entry-id/thumbnail",
  "spacebyteEntryId": "spacebyte-entry-id",
  "spacebyteHash": "download-hash-from-file-entry"
}
```

The exact property names for entry ID, hash, parent folder, file type, and image URL should be confirmed from the expanded `FileEntry` schema in the SpaceByte API page.

## Backend Data To Store Locally

For a lightweight app, keep only app-specific metadata in your own storage:

```text
galleries
- slug
- event_name
- event_date
- client_name
- spacebyte_root_folder_id or folder_path
- access rules

viewers
- gallery_slug
- role: client or guest
- email_or_mobile
- display_name

favorites
- gallery_slug
- email_or_mobile
- role
- spacebyte_entry_id
- created_at
```

SpaceByte remains the source of truth for files and folders.

## What Is Still Needed From The Expanded Docs

The screenshots show the endpoint list, but not the request/query parameters or response body fields. Before wiring the real API, confirm these from Swagger:

- `GET /drive/file-entries` query parameters for folder ID/path and pagination
- `FileEntry` fields for ID, hash, name, type, MIME type, parent ID, URL, and thumbnail URL
- Whether `GET /file-entries/download/{hashes}` returns a redirect, JSON with a URL, or a file stream
- Whether shareable links can be made public, password protected, or expire
