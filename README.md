# Eesa Documents — chat-based document management (plugin)

A standalone Eesa marketplace plugin (like Attendance). Each tenant connects **their own** Google Drive; the plugin indexes document **content** for semantic search and lets the agent find the right file by meaning. **File bytes never leave the client's Drive** — the plugin keeps only embeddings + metadata + links.

- **Storage:** the client's own Google Drive — **pluggable**; Dropbox / OneDrive / Box / S3 drop in as new `src/providers/*` modules (see below)
- **Extraction:** OSS (pdf-parse / mammoth / xlsx) + Tesseract OCR for images **and scanned PDFs** (rasterised via pdfjs + @napi-rs/canvas)
- **Embeddings:** local FastEmbed (BGE-small, on-box, $0)
- **Index:** the plugin's own Qdrant, partitioned by `tenant_id`
- **Cost to Eesa:** $0 in vendor bills (only the Coolify compute it already runs)

## Surfaces
| Surface | What |
|---|---|
| `POST /mcp` | agent tools: `search_documents`, `list_documents`, `get_document_link` |
| `/api/*` | OAuth connect, status, search, sync (token-authed; the Google callback is open, trusted via signed state) |
| `GET /app` | embedded admin UI: connect Drive + status + search |

## Scope
- **Google Drive** connector, **admin-only** (staff/permissions come later).
- Auto-index the **existing** Drive + an auto-created "Eesa Documents" folder.
- Retrieval via **chat** (semantic). **Upload via the plugin UI is built** (browser → plugin → the client's Drive, then indexed). Chat-native filing (attach a file in chat) is **Phase 3** — the one change that needs an Eesa-core bridge.

## Adding a storage provider (Dropbox, OneDrive, Box, S3…)
The whole pipeline is provider-agnostic. To add one:
1. Create `src/providers/<name>.js` implementing the interface documented at the top of `src/providers/google_drive.js` (`key`, `label`, `authUrl`, `exchangeCode`, `ensureFolder`, `listAllFiles`, `downloadContent`, `uploadFile`) — all yielding the normalized file shape `{ id, name, mimeType, link, size, hash }`.
2. Register it in `src/providers/index.js` (one line).
That's it — connect routes (`/api/connect/:provider/*`), sync, ingest, upload, and search all work unchanged.

## Deploy
1. **Postgres:** `psql "$DATABASE_URL" -f db/schema.sql`
2. **Qdrant:** run a Qdrant service on Coolify; set `QDRANT_URL` (+ `QDRANT_API_KEY` if enabled).
3. **Google OAuth:** create an OAuth client (Google Cloud console), add `https://<host>/api/connect/google_drive/callback` as an authorized redirect URI, set `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
4. **Secrets:** `PLUGIN_ENC_KEY` and `PLUGIN_GATEWAY_SECRET` = `openssl rand -hex 32` each (server env only; the gateway secret also goes on the platform connection).
5. Set the rest of `.env` (see `.env.example`), then `npm install && npm start`.
6. Register/publish the plugin so the platform syncs its manifest + tools.

## Notes
- Scanned-PDF OCR (rasterising pages) is a Phase-2 refinement; today a no-text PDF is marked `skipped`.
- The embedded UI needs the shell's UI-session token; it reads it from `?t=`, `#t=`, or `window.__EESA_UI_TOKEN__` — align with however the shell passes it.
