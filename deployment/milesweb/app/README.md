# Starz Shots Gallery

This project is a Node.js gallery application built with a custom HTTP server in `server.js`, client-side gallery UI in `app.js`, and styling in `styles.css`.

## Run locally

1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set values.
4. Start the server: `npm start`.

## MilesWeb deployment

Use the prepared package in `deployment/milesweb`. This is a Node.js service,
so create it through MilesWeb's **Setup Node.js App** feature; uploading files
to `public_html` alone will not start the server. The deployment package omits
secrets. Set its environment variables in the MilesWeb Node.js application
screen, then verify `/healthz` after restart.

## Files

- `server.js` — backend static server and API endpoints.
- `app.js` — frontend gallery UI.
- `styles.css` — app styles.
- `config/galleries.json` — gallery metadata.
- `data/gallery.sample.js` — sample gallery content for local development.
