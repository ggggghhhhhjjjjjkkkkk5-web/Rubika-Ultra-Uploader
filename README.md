# Rubika Ultra Uploader (starter)

A private web panel + background worker for queueing direct-download URLs and forwarding files to a Rubika channel.

## Important Rubika limitation
This project deliberately does **not** pretend that a normal Bot API can upload arbitrary 1GB+ files. The included adapter is a safe integration boundary. You must provide a supported Rubika upload implementation/account session and verify the platform's current upload limits. No undocumented endpoints, session scraping, or bypasses are included.

## Features
- Password-protected private panel
- Add direct file URLs to a persistent Redis queue
- Server-side streaming download to a persistent disk
- File size cap configurable by environment
- URL safety checks (HTTP/HTTPS only, block private/local IP ranges)
- Queue worker, retries, progress/status tracking
- Adapter interface for a supported Rubika client
- Docker + Render Blueprint starter

## Local run
1. Copy `.env.example` to `.env` and set a long `ADMIN_PASSWORD` and `SESSION_SECRET`.
2. `docker compose up --build`
3. Open http://localhost:3000

Without a configured Rubika adapter, jobs download and stop at `awaiting_rubika_adapter`; downloaded files are retained on the persistent disk and are not falsely marked as published. The adapter is intentionally not wired to undocumented account endpoints.

## Deployment
Use a Render workspace with a paid persistent disk and a Redis-compatible Key Value instance. Render's free ephemeral filesystem is not suitable for retaining multi-GB downloads. Review `render.yaml` before applying any paid infrastructure.

## Safety
Only submit files you own or have permission to distribute. Never commit `.env`, cookies, tokens, or session files.
