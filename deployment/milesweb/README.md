# Starz Shots Gallery — MilesWeb deployment

This folder is built as a clean upload package for MilesWeb. It intentionally
does **not** contain `.env`, `node_modules`, or existing favourite submissions.

## Upload and run

1. In MilesWeb mPanel, open **Setup Node.js App**. If that option is not
   available, the hosting plan cannot run this Node.js application; ask
   MilesWeb support to enable Node.js/Passenger or use a Node-capable plan.
2. Create an application for the domain (or subdomain) where the gallery will
   be published. Use Node.js 18 or newer.
3. Open `/public_html/gallery` in mPanel File Manager, upload
   `starzshots-gallery-milesweb.zip`, and extract it there.
   The extracted files must sit directly in `public_html/gallery` (for example,
   `public_html/gallery/server.js` and `public_html/gallery/index.html`), not
   inside an extra nested folder.
4. In **Setup Node.js App**, choose the domain and set the application root to
   `public_html/gallery`. Set the application URL to `/gallery` and the
   startup file to `server.js`.
5. Run `npm install` from the
   application root if mPanel does not do so automatically.
6. In the Node.js app environment-variable screen, add the values from
   `.env.example` using the real SpaceByte token and a new strong `ADMIN_TOKEN`.
   Do not upload a local `.env` file.
7. Set `APP_BASE_PATH` to `/gallery`, restart the application, then confirm
   `https://YOUR-DOMAIN/gallery/healthz` returns `{"ok":true}`.

## Required environment variables

`SPACEBYTE_BASE_URL`, `SPACEBYTE_TOKEN`, `SPACEBYTE_ALLOW_INSECURE_TLS`,
`ADMIN_TOKEN`, and `APP_BASE_PATH=/gallery`. MilesWeb assigns `PORT`; do not
set it unless their Node.js app screen specifically instructs you to.

## Writable application data

The running app writes favourite submissions to
`public_html/gallery/data/favorites-submissions.json`. Ensure the Node.js
application user can write to the `data` directory. Back it up before
redeploying.

## Deployment check

After restart, check `https://YOUR-DOMAIN/gallery/healthz`, then log in to
`https://YOUR-DOMAIN/gallery/admin`. Use **SpaceByte status**, then open each
event with its access code. A successful health check only verifies the Node
application; the admin check verifies its SpaceByte connection.
