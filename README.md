# Starz Shots Gallery

This project is a Node.js gallery application built with a custom HTTP server in `server.js`, client-side gallery UI in `app.js`, and styling in `styles.css`.

## Run locally

1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set values.
4. Start the server: `npm start`.

## Files

- `server.js` — backend static server and API endpoints.
- `app.js` — frontend gallery UI.
- `styles.css` — app styles.
- `config/galleries.json` — gallery metadata.
- `data/gallery.sample.js` — sample gallery content for local development.

## Public homepage

The root page is the public Starz Shots business homepage. It is static HTML/CSS/JavaScript and can be uploaded directly to WordPress hosting or any shared host that serves static files.

Before publishing, add the supplied files using this layout:

```text
assets/STZ_2628.jpg
assets/black.png
photos/photo-01.jpg
photos/photo-02.jpg
...
photos/photo-20.jpg
```

The works section reads every supported image in `photos/`, shuffles them, and displays a maximum of 20 on every page load. Images are rendered at their natural proportions, so portrait and landscape photos keep their orientation. On startup, the Node server uses Sharp to apply EXIF orientation, resize large uploads to a maximum of 1800px, and replace the original file with the optimized version. This removes the high-resolution original from the public folder after conversion. Because browsers cannot list a server directory, the Node homepage also requires the updated `server.js` endpoint at `/api/home-photos`.

On MilesWeb, upload the updated `server.js`, `home.js`, `home.css`, `index.html`, `package.json`, and `package-lock.json` to `public_html`. Run `npm install` in the root Node app or use the hosting panel's dependency installer. While the Node app is running, new supported images added to `photos/` are automatically normalized, resized, compressed, and replaced in place; no high-resolution original is retained. The email address in the contact section is a placeholder and should be changed to the studio's preferred inbox.