# FileStorm

A private web panel and background worker for queueing direct-download URLs, downloading large files, and preparing them for publication to a destination channel.

## Current status

- Private password-protected Persian panel
- Direct URL submission and destination channel ID field
- Redis/BullMQ job queue and worker
- Streaming downloads with a configurable size cap
- Docker-based local deployment
- Safe adapter boundary for a supported destination-platform upload client

**Important:** The current Rubika publishing adapter is a placeholder. Files can be downloaded, but they are not published to a channel until a supported and verified upload implementation is connected. Do not treat a queued or downloaded job as a successful publication.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a strong, unique `ADMIN_PASSWORD` and `SESSION_SECRET`.
3. Start the stack with `docker compose up --build`.
4. Open `http://localhost:3000`.

Local Docker is the intended no-hosting-fee test path. It uses the disk on the computer running it, so available storage must be greater than the file size plus working space. Keeping the computer online is required while jobs run.

## Hosting

The included Render Blueprint uses paid resource types and a persistent disk. **Do not apply it if you require a completely free deployment.** Render's free ephemeral filesystem is not suitable for retaining multi-gigabyte downloads.

## Security

- Only submit public HTTP/HTTPS direct-download URLs.
- Only upload files you own or are authorized to distribute.
- Never commit `.env`, passwords, access tokens, cookies, or session files.
- Never use undocumented private endpoints or scrape account sessions.
