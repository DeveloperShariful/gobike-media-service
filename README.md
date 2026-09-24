# GoBike Media Upload Service

A small Express service that runs on `media.gobike.au`, handling:
- signed image/video uploads from the main GoBike site (compression, ffmpeg transcode for video)
- serving/deleting uploaded files
- storage usage stats for the admin media library

## Environment variables

Set these in the hosting platform's environment configuration (never commit a `.env` file):

- `UPLOAD_SECRET` — shared HMAC secret matching `HOSTINGER_UPLOAD_SECRET` in the main Next.js app
- `PORT` — injected by the host; the app also falls back to `39281` if unset
- `CALLBACK_URL` — full URL of the main app's `/api/media/upload/hostinger-callback` endpoint (defaults to the production URL if unset)

## Start command

```
node server.js
```
