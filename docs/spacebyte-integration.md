# SpaceByte Integration

This project can synchronize galleries with SpaceByte using the `/api/admin/events` endpoint.

Environment variables:

- `SPACEBYTE_BASE_URL` — SpaceByte API base URL
- `SPACEBYTE_TOKEN` — SpaceByte API bearer token
- `SPACEBYTE_AUTH_SCHEME` — Authorization scheme prefix (default: `Bearer`)
- `ADMIN_TOKEN` — admin API authorization token

The server uses `spacebyteJson()` to query files and validate gallery folders.

## Diagnostics

Use the admin diagnostics endpoint to validate SpaceByte access from Render without exposing secrets:

- `GET /api/admin/spacebyte-status`
- Header: `x-admin-token: <ADMIN_TOKEN>` (or `Authorization: Bearer <ADMIN_TOKEN>`)

The response includes:

- whether SpaceByte env vars are configured,
- a basic API connectivity check,
- per-gallery folder access checks with request URL and error details.