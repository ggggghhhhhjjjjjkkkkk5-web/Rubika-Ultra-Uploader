# FileStorm

A Persian password-protected panel that downloads a public direct HTTP/HTTPS file and publishes it to a channel through the **official Rubika Bot API**.

## Setup

1. Create a bot with BotFather and copy its API token.
2. Add the bot to the destination channel as an administrator with permission to send messages/files.
3. Open the panel, enter the admin password, paste the bot token, and use **Check bot connection**.
4. Enter the direct file URL and destination channel ID, then submit.

The bot token is supplied over HTTPS for each job, kept only in process memory while that job runs, and is not written into the job list or repository.

## Official publishing flow

The app uses the documented Bot API v3 flow:
- `getMe` to verify the bot token
- `requestSendFile` to obtain an upload URL
- multipart upload to that URL
- `sendFile` to publish the returned `file_id` to the destination chat

See the official documentation: https://rubika.ir/botapi and https://rubika.ir/botapi/methods

## Hosting limits

The included free Render test service is intentionally capped at 950,000,000 bytes. Its filesystem is temporary and the free instance may sleep. It is not a reliable host for files larger than 1 GB or long-running transfers. For multi-gigabyte files, run the app on a machine/server with sufficient disk space, stable connectivity, and a configured larger `MAX_FILE_BYTES`.

## Run locally

1. Install Node.js 20+.
2. Set `ADMIN_PASSWORD` and a long random `SESSION_SECRET`.
3. Optionally set `DATA_DIR`, `MAX_FILE_BYTES`, and `DOWNLOAD_TIMEOUT_MS`.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

## Security

- Never commit bot tokens, passwords, cookies, or session data.
- Only submit public HTTP/HTTPS URLs to files you are authorized to distribute.
- The bot must have permission to post in the destination channel.
- The free deployment uses in-memory job/session state; pending jobs are lost if the service restarts.
