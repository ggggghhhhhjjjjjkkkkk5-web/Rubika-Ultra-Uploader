# FileStorm

A Persian, password-protected test panel for downloading files from direct HTTP/HTTPS URLs.

## Test deployment

This single-service edition is designed for a free web-service smoke test. It uses in-memory job state and temporary server storage: jobs and downloaded files can disappear when the service restarts or sleeps. It is **not** suitable for reliable multi-gigabyte transfers on free hosting.

## Run locally (recommended for large files)

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

For large downloads, use a computer with enough free disk space and keep it running. This test server caps downloads using `MAX_FILE_BYTES` (default 950 MB); increase it only for a local machine with sufficient free storage.

## Publication status

The current version only downloads and retains a file temporarily. It does not publish to a channel. A supported and verified destination upload adapter is still required; no undocumented endpoints or account-session scraping are used.

## Security

Use a strong admin password. Only submit public HTTP/HTTPS links to files you are authorized to distribute. Never commit passwords, tokens, cookies, or session data.
