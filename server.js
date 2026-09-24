// media.gobike.au upload+transcode service, running on medianew.gobike.au
// (see STORAGE note below for why the domain split).
// - video -> saved raw immediately (URL is final right away), then
//   transcoded (H.264/AAC MP4) by a background queue worker — see the
//   "ASYNC VIDEO TRANSCODE QUEUE" section below for why.
// - image -> compressed synchronously (fast enough not to need queuing).
//
// AUTH: two modes, same as the old upload.php bridge this replaces —
// (1) a static shared secret (x-upload-secret) for server-to-server calls
//     (delete/stats, called from Next.js server code that can hold the raw
//     secret), and (2) a short-lived HMAC signature (x-upload-timestamp +
//     x-upload-signature over "timestamp:folder") for the browser's direct
//     upload, which must never see the raw secret. This app is now the
//     public-facing endpoint itself (no PHP bridge in front of it anymore),
//     so it also needs to handle CORS for the direct browser calls.
// STORAGE: this app runs as a Hostinger "Web App" (managed Node.js), which
// deploys into a fresh, versioned hbuilds/versions/<uuid>/ folder on every
// redeploy, and — confirmed by direct testing — its local filesystem writes
// never reach the real host disk at all (they land in an isolated container
// overlay that vanishes with the container). So nothing written to local
// disk here is ever served directly; local disk is used only as scratch
// space for ffmpeg, and every final file is pushed out over FTP to
// media.gobike.au's own (non-versioned, stable) public_html — the exact
// directory that's already served at the https://media.gobike.au/uploads/...
// URLs this app returns.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ftp = require('basic-ftp');

const app = express();
const PORT = process.env.PORT || 39281;
const SECRET = process.env.UPLOAD_SECRET || '';

// FTP account for media.gobike.au (created specifically for this app — see
// hPanel > media.gobike.au > Files > FTP Accounts). A fresh login's default
// working directory is "/public_html", but "/" (once explicitly cd'd to,
// see withFtp() below) is the site's own root, one level ABOVE public_html —
// confirmed by testing: `CWD /` then `PWD` returns "/", not "/public_html".
// So every remote path here is written out in full from that true root:
// "public_html/uploads/..." for served files, "originals/..." for the
// private backup (a genuine sibling of public_html, same as the pre-Web-App
// architecture — NOT web-reachable, unlike an earlier attempt at this that
// assumed the root was public_html and landed backups inside it instead).
const FTP_HOST = process.env.FTP_HOST || '77.37.79.94';
const FTP_USER = process.env.FTP_USER || '';
const FTP_PASSWORD = process.env.FTP_PASSWORD || '';

// Purely local scratch space (multer destination + ffmpeg working files).
// Never read back after a redeploy — every request creates what it needs
// and cleans up after itself.
const TMP_DIR = path.join(__dirname, 'tmp');
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://gobike.au/api/media/upload/hostinger-callback';

fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB cap

// Same allowed origins / preflight response the old upload.php bridge sent —
// this app is now the direct target of the browser's cross-origin POST.
const ALLOWED_ORIGINS = new Set(['https://gobike.au', 'https://www.gobike.au']);
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
}
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-upload-timestamp, x-upload-signature, x-upload-secret, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const SIGNATURE_MAX_AGE_SECONDS = 600; // matches the old upload.php bridge

function timingSafeEqualHex(expectedHex, providedHex) {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Folder is read from the query string, not the multipart body — this
// middleware runs before multer parses the body, so req.body isn't
// populated yet. hostinger-sign/route.ts bakes the same folder value it
// signed into the returned uploadUrl's query string for exactly this reason.
function checkAuth(req, res, next) {
  if (!SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const staticSecret = req.header('x-upload-secret');
  if (staticSecret && staticSecret === SECRET) return next();

  const timestamp = req.header('x-upload-timestamp');
  const signature = req.header('x-upload-signature');
  if (timestamp && signature) {
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) {
      return res.status(401).json({ error: 'Signature expired' });
    }
    const folder = typeof req.query.folder === 'string' ? req.query.folder : 'general';
    const expected = crypto.createHmac('sha256', SECRET).update(`${timestamp}:${folder}`).digest('hex');
    try {
      if (timingSafeEqualHex(expected, signature)) return next();
    } catch {
      // malformed signature (bad hex/length) — falls through to Unauthorized
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── FTP HELPERS ────────────────────────────────────────────────────────────
// A fresh connection per operation-group (not pooled) — uploads happen at
// most a few times a minute on this store's traffic, so connection setup
// cost is a non-issue, and it avoids ever reusing a connection whose cwd
// state got left somewhere unexpected by a previous request.
async function withFtp(fn) {
  const client = new ftp.Client(30_000);
  try {
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASSWORD, secure: false });
    await client.cd('/'); // normalize away from the "/public_html" default login dir — see note above
    return await fn(client);
  } finally {
    client.close();
  }
}

// Existing filenames in a remote dir, for collision-avoidance — one listing
// per upload rather than a round trip per candidate name. A remote dir that
// doesn't exist yet (first upload into a new folder) just means "no names
// taken", not an error.
async function listRemoteNames(client, remoteDir) {
  try {
    const entries = await client.list(remoteDir);
    return new Set(entries.map((e) => e.name));
  } catch {
    return new Set();
  }
}

async function uploadFileToFtp(client, localPath, remoteDir, remoteName) {
  await client.ensureDir(remoteDir);
  await client.uploadFrom(localPath, remoteName);
  await client.cd('/'); // reset cwd so a later ensureDir() in the same connection isn't relative to this one
}

// Untouched copy of every upload, kept as a backup before any compression/
// transcode happens — never read back by this service, purely a safety net
// (e.g. a warranty claim or affiliate KYC document that later needs to be
// viewed at full original quality, not the web-compressed copy). Lives in
// "originals/", a genuine sibling of public_html — outside the web root
// entirely, not just an obscure path inside it — so it's never web-reachable
// by any URL, matching how this folder worked before this app moved to
// Hostinger's Web App hosting type. Still keyed by a random token rather
// than the original filename/slug (defense in depth, and slugs risk
// collisions across unrelated uploads that a random token can't).
async function backupOriginalToFtp(client, localPath, type, folder, ext) {
  const remoteDir = `originals/${type}/${folder}`;
  const remoteName = crypto.randomBytes(16).toString('hex') + ext;
  try {
    await uploadFileToFtp(client, localPath, remoteDir, remoteName);
  } catch (err) {
    console.error('[backup] failed to save original (upload itself is unaffected):', err.message);
  }
}

// ─── NAMING ─────────────────────────────────────────────────────────────────
// Slug from the ORIGINAL uploaded filename (e.g. "20 Inch GoBike Electric
// Balance Bike.jpg" -> "20-inch-gobike-electric-balance-bike") so the final
// URL carries descriptive keywords — a real (if minor) Google Images SEO
// signal, and just more useful/readable than a bare hash on its own.
function slugify(name) {
  return (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\.[a-zA-Z0-9]+$/, '') // drop existing extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Pure "slug.ext" whenever that name is actually free in the target folder.
// Only on an actual collision (two uploads landing on the same slug) does a
// suffix get added — WordPress's own convention (name-1.ext, name-2.ext,
// ...), not a random hash, since it's human-readable and this codebase's own
// migrated WordPress filenames already follow this exact pattern.
function uniqueName(existingNames, ext, originalFilename) {
  const slug = slugify(originalFilename);
  if (!slug) return crypto.randomBytes(16).toString('hex') + ext; // no usable original name at all

  const plain = slug + ext;
  if (!existingNames.has(plain)) return plain;

  for (let i = 1; i < 1000; i++) {
    const candidate = `${slug}-${i}${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${slug}-${crypto.randomBytes(4).toString('hex')}${ext}`; // extreme fallback, practically unreachable
}

// Same resize expression used for the actual video encode below — reused
// here so the reference (original) gets scaled down to exactly match the
// compressed output's dimensions before comparison (the quality filter
// requires equal frame sizes). NOTE: ffmpeg's scale2ref filter would do this
// generically, but it crashes/produces zero frames on this ffmpeg-static
// build ("No filtered frames for output stream" / filter-graph assertion
// failure) — confirmed by direct testing — so we pass a matching scale
// expression by hand instead.
const VIDEO_SCALE = "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const IMAGE_SCALE = "scale='min(2500,iw)':'min(2500,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

// Perceptual quality score (0-100) of the compressed output vs. the original,
// measured with the same family of metric the industry (Netflix, AWS
// Elemental, Bitmovin, ...) uses to validate encoding quality. Best-effort:
// on any failure this resolves null rather than failing anything — a score
// is a nice-to-have, not something that should ever block a real upload.
function runFfmpegQualityFilter(distPath, refPath, refScaleExpr, filterName, scoreRegex) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, [
      '-i', distPath, '-i', refPath,
      '-lavfi', `[1:v]${refScaleExpr}[ref];[0:v][ref]${filterName}`,
      '-f', 'null', '-',
    ], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[${filterName}] measurement failed:`, err.message);
        return resolve(null);
      }
      const m = scoreRegex.exec(stderr || '');
      resolve(m ? parseFloat(m[1]) : null);
    });
  });
}

const computeVMAF = (distPath, refPath) =>
  runFfmpegQualityFilter(distPath, refPath, VIDEO_SCALE, 'libvmaf', /VMAF score:\s*([\d.]+)/);

// SSIM's "All:" value is 0-1 — scale to 0-100 to match VMAF's range so both
// share one qualityScore field/UI.
async function computeSSIM(distPath, refPath) {
  const raw = await runFfmpegQualityFilter(distPath, refPath, IMAGE_SCALE, 'ssim', /All:([\d.]+)/);
  return raw === null ? null : raw * 100;
}

// Simple branded landing page — this service has no UI of its own (every
// other route is a JSON API meant to be called by code, not browsed), but a
// bare "Cannot GET /" looked broken to a visitor who typed the domain
// directly. Purely cosmetic — doesn't touch any of the actual API routes.
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GoBike Media Service</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    color: #f5f5f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    text-align: center;
    padding: 24px;
  }
  .card { max-width: 480px; }
  .logo {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 0.5px;
    color: #ffd60a;
    margin-bottom: 8px;
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; color: #f5f5f5; }
  p { font-size: 14px; line-height: 1.6; color: #a3a3a3; margin: 0 0 24px; }
  a.home {
    display: inline-block;
    padding: 10px 22px;
    background: #ffd60a;
    color: #0a0a0a;
    font-weight: 700;
    font-size: 14px;
    text-decoration: none;
    border-radius: 8px;
  }
  a.home:hover { background: #ffe14d; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">GoBike</div>
    <h1>Media Processing Service</h1>
    <p>This is a backend service that compresses and transcodes images and videos for the GoBike Australia website. It has no content of its own to browse.</p>
    <a class="home" href="https://gobike.au">Visit GoBike Australia →</a>
  </div>
</body>
</html>`);
});

app.get('/health', (req, res) => res.json({ ok: true, ffmpeg: !!ffmpegPath, queue: queue.length }));

// uploads/ ফোল্ডারের মোট সাইজ + ফাইল সংখ্যা রিপোর্ট করে — admin media
// widget-এ Hostinger-এর storage ব্যবহার দেখানোর জন্য। Recursive FTP walk —
// this endpoint isn't hit often (an admin dashboard widget), so the extra
// round trips are a non-issue.
async function ftpDirStats(client, remoteDir) {
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [remoteDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await client.list(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory) stack.push(full);
      else if (entry.isFile) {
        totalBytes += entry.size;
        fileCount++;
      }
    }
  }
  return { totalBytes, fileCount };
}

app.get('/stats', checkAuth, async (req, res) => {
  try {
    const stats = await withFtp((client) => ftpDirStats(client, 'public_html/uploads'));
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[stats] failed:', err.message);
    res.status(500).json({ error: 'Stats failed', detail: err.message });
  }
});

// ─── ASYNC VIDEO TRANSCODE QUEUE ────────────────────────────────────────────
// Why: transcoding a real-world video (a few minutes of 4K phone footage) can
// take multiple minutes on this shared host's ~2 usable cores — long enough
// to hit a request timeout, and worse, to leave a browser upload spinner
// stuck for minutes with the user unsure if it's frozen. So the /upload
// video path now: (1) saves the ORIGINAL bytes straight to the FINAL public
// URL (via FTP) and responds immediately — the video is playable right away,
// just not yet compressed; (2) queues a transcode job that works off the
// LOCAL scratch copy still sitting in TMP_DIR (the queue is worked almost
// immediately — enqueue() kicks it right away — so in practice the local
// file is read back within seconds, well before this container would ever
// be recycled). A background worker (this same process) works through the
// queue one job at a time (respecting the same 2-core reality that motivated
// -threads 2 elsewhere), and once done, FTP-uploads the compressed file over
// the SAME remote path (the URL never changes, no DB update needed for it).
//
// The queue is persisted to local disk (QUEUE_FILE) purely so a same-process
// restart mid-session doesn't drop an in-flight job; it is NOT relied on to
// survive a redeploy. If a redeploy happens to land in the narrow window
// between a video's initial (raw) upload and its background transcode, that
// one video just stays raw/uncompressed (still fully playable — same
// "needs manual look" fallback this queue already had for repeated ffmpeg
// failures) rather than being lost.
const QUEUE_FILE = path.join(__dirname, 'transcode-queue.json');
const FAILED_FILE = path.join(__dirname, 'transcode-failed.json');
const MAX_ATTEMPTS = 5;

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function saveQueue() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}
function appendFailed(job, reason) {
  const failed = loadJson(FAILED_FILE);
  failed.push({ ...job, failedAt: new Date().toISOString(), reason });
  fs.writeFileSync(FAILED_FILE, JSON.stringify(failed, null, 2));
}

let queue = loadJson(QUEUE_FILE);
let workerBusy = false;

function enqueue(job) {
  queue.push({ attempts: 0, addedAt: new Date().toISOString(), ...job });
  saveQueue();
  processQueue(); // kick immediately — don't make the first job wait for the interval tick
}

async function notifyCallback(url, qualityScore, size) {
  try {
    await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-upload-secret': SECRET },
      body: JSON.stringify({ url, qualityScore, size, transcodePending: false }),
    });
  } catch (err) {
    // Non-fatal — the video itself is already correctly transcoded in place.
    // Only the admin-UI quality badge / "still processing" flag stays stale.
    console.error('[queue] callback notify failed (video itself is fine):', err.message);
  }
}

async function processQueue() {
  if (workerBusy) return; // one job at a time — matches the 2-core reality
  const job = queue[0];
  if (!job) return;
  workerBusy = true;

  const tmpOut = job.localRawPath + '.transcoding.mp4';
  try {
    const args = [
      '-y', '-threads', '2', '-i', job.localRawPath,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
      '-vf', VIDEO_SCALE,
      '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      tmpOut,
    ];
    // -preset slow (not veryslow): tried veryslow first since this runs in
    // the background with no response-time pressure, but on this host it
    // backfired — sustained high CPU from a long veryslow encode got the
    // whole process killed by the shared-hosting environment mid-transcode
    // (confirmed: process uptime reset, job had to restart from scratch,
    // twice, on the very first real-world video). slow already proved
    // reliable (all 54 migrated videos succeeded on it) and finishes in a
    // fraction of the time — better to actually complete than to chase
    // marginally better compression and risk never finishing.
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.slice(-2000) || err.message));
        resolve();
      });
    });

    const qualityScore = await computeVMAF(tmpOut, job.localRawPath);
    const newSize = fs.statSync(tmpOut).size;

    // Poster thumbnail — the frontend (MediaCarousel.tsx) expects one at
    // this exact sibling path (video URL with its extension swapped for
    // .jpg — a convention carried over from Cloudinary, which auto-generated
    // one there). "thumbnail" picks a representative non-black/non-fade
    // frame from an early sample window, rather than just grabbing frame 0.
    const posterLocalPath = tmpOut.replace(/\.transcoding\.mp4$/, '.poster.jpg');
    let hasPoster = false;
    try {
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
          '-y', '-i', tmpOut,
          '-vf', "thumbnail,scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
          '-frames:v', '1',
          posterLocalPath,
        ], { maxBuffer: 1024 * 1024 * 20 }, (err) => (err ? reject(err) : resolve()));
      });
      hasPoster = true;
    } catch (err) {
      console.error(`[queue] poster generation failed for ${job.url} (non-fatal):`, err.message);
    }

    // Push the transcoded file (and poster) out to persistent storage,
    // overwriting the same remote name the raw upload already used — the
    // public URL never changes.
    await withFtp(async (client) => {
      await uploadFileToFtp(client, tmpOut, job.remoteDir, job.remoteName);
      if (hasPoster) {
        const posterName = job.remoteName.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
        await uploadFileToFtp(client, posterLocalPath, job.remoteDir, posterName);
      }
    });

    fs.unlink(tmpOut, () => {});
    fs.unlink(posterLocalPath, () => {});
    fs.unlink(job.localRawPath, () => {});

    queue.shift();
    saveQueue();
    console.log(`[queue] transcoded OK: ${job.url} (VMAF ${qualityScore}, ${job.originalSize} -> ${newSize} bytes)`);
    await notifyCallback(job.url, qualityScore, newSize);
  } catch (err) {
    fs.unlink(tmpOut, () => {}); // clean up a partial attempt, if any
    job.attempts = (job.attempts || 0) + 1;
    console.error(`[queue] attempt ${job.attempts}/${MAX_ATTEMPTS} failed for ${job.url}:`, err.message);
    if (job.attempts >= MAX_ATTEMPTS) {
      queue.shift();
      appendFailed(job, err.message);
      fs.unlink(job.localRawPath, () => {});
      console.error(`[queue] GIVING UP after ${MAX_ATTEMPTS} attempts: ${job.url} — raw file stays live, uncompressed. Needs manual look.`);
    }
    saveQueue();
  } finally {
    workerBusy = false;
  }

  if (queue.length > 0) setImmediate(processQueue); // more waiting — keep going
}

// Safety net: catches anything the immediate kick missed (e.g. jobs reloaded
// from disk on a fresh process start within the same container lifetime).
setInterval(processQueue, 60 * 1000);
processQueue(); // resume whatever was left in the queue from before a restart

app.post('/upload', checkAuth, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });

  const isVideo = (file.mimetype || '').startsWith('video/');
  const folder = req.body.folder && /^[a-z0-9_-]+$/i.test(req.body.folder) ? req.body.folder : 'general';

  try {
    if (isVideo) {
      const remoteDir = `public_html/uploads/video/${folder}`;
      const existing = await withFtp((client) => listRemoteNames(client, remoteDir));
      const outName = uniqueName(existing, '.mp4', file.originalname);

      // Keep the raw upload on local scratch disk — the queue worker (kicked
      // immediately below) reads it back from here to transcode. Not deleted
      // until the worker has finished with it.
      const localRawPath = path.join(TMP_DIR, `raw-${crypto.randomBytes(8).toString('hex')}.mp4`);
      fs.copyFileSync(file.path, localRawPath);
      fs.unlink(file.path, () => {});

      // Raw bytes go live immediately — playable right away, just not yet compressed.
      // Backed up as the "original" here (not after transcoding) since the
      // queue worker later overwrites this same file in place with the
      // compressed version — this is the last point these exact bytes exist.
      const videoExt = path.extname(file.originalname) || '.mp4';
      await withFtp(async (client) => {
        await uploadFileToFtp(client, localRawPath, remoteDir, outName);
        await backupOriginalToFtp(client, localRawPath, 'video', folder, videoExt);
      });

      const url = `https://media.gobike.au/uploads/video/${folder}/${outName}`;
      enqueue({ url, localRawPath, remoteDir, remoteName: outName, folder, originalSize: file.size });

      return res.json({
        success: true, url, type: 'video',
        qualityScore: null, transcodePending: true,
        size: file.size, originalSize: file.size, // same for now — the callback updates `size` once compressed
      });
    } else {
      const remoteDir = `public_html/uploads/image/${folder}`;

      // GIF (animation) and SVG (vector) must never be re-encoded as a
      // raster WebP — that would break animation / rasterize a vector.
      // Copy these through as-is; everything else gets Cloudinary-style
      // q_auto/f_auto treatment: convert to WebP (universally supported,
      // smaller than JPEG/PNG at equal visual quality) at a near-lossless
      // quality, capping resolution at 2500px on the long edge (raw phone
      // photos are routinely 4000px+, far beyond anything the site displays,
      // so this is invisible in the browser but cuts file size a lot). This
      // stays synchronous — a still image compresses in a couple seconds,
      // nowhere near long enough to need the video's async treatment.
      const mime = file.mimetype || '';
      const skipCompression = mime === 'image/gif' || mime === 'image/svg+xml';

      if (!skipCompression) {
        try {
          const existing = await withFtp((client) => listRemoteNames(client, remoteDir));
          const outName = uniqueName(existing, '.webp', file.originalname);
          const outPath = path.join(TMP_DIR, `out-${crypto.randomBytes(8).toString('hex')}.webp`);
          const args = [
            '-y', '-i', file.path,
            '-vf', IMAGE_SCALE,
            '-c:v', 'libwebp', '-quality', '82', '-preset', 'photo',
            // Some phones (Samsung/Google "Motion Photo", some Live Photo
            // exports) save a still shot as a JPEG with a few seconds of
            // video appended in the same file. ffmpeg's demuxer picks up
            // both streams, and without this flag libwebp happily encodes
            // every frame it finds — producing a 2-frame *animated* WebP
            // where frame 2 is pulled from that embedded clip (often dark/
            // different from the actual photo). Forces exactly one frame,
            // same fix already used for video poster extraction above.
            '-frames:v', '1',
            outPath,
          ];
          await new Promise((resolve, reject) => {
            execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr?.slice(-2000) || err.message));
              resolve();
            });
          });
          const qualityScore = await computeSSIM(outPath, file.path);
          const compressedSize = fs.statSync(outPath).size;

          const imageExt = path.extname(file.originalname) || '.jpg';
          await withFtp(async (client) => {
            await uploadFileToFtp(client, outPath, remoteDir, outName);
            await backupOriginalToFtp(client, file.path, 'image', folder, imageExt);
          });
          fs.unlink(outPath, () => {});
          fs.unlink(file.path, () => {});
          const url = `https://media.gobike.au/uploads/image/${folder}/${outName}`;
          return res.json({
            success: true, url, type: 'image', qualityScore,
            size: compressedSize, originalSize: file.size,
          });
        } catch (err) {
          // Unsupported input for this ffmpeg build (some HEIC variants,
          // corrupt files, etc.) — fall through to a raw copy below so the
          // upload still succeeds. The client-side fallback chain
          // (Cloudinary/Vercel) exists for cases even that can't handle.
          console.error('[upload] image compress failed, falling back to raw copy:', err.message);
        }
      }

      const ext = path.extname(file.originalname) || '';
      const existing = await withFtp((client) => listRemoteNames(client, remoteDir));
      const rawName = uniqueName(existing, ext, file.originalname);
      await withFtp((client) => uploadFileToFtp(client, file.path, remoteDir, rawName));
      fs.unlink(file.path, () => {});
      const url = `https://media.gobike.au/uploads/image/${folder}/${rawName}`;
      return res.json({ success: true, url, type: 'image', size: file.size, originalSize: file.size });
    }
  } catch (err) {
    fs.unlink(file.path, () => {});
    console.error('[upload] failed:', err.message);
    return res.status(500).json({ error: 'Processing failed', detail: err.message });
  }
});

// { path: "image/general/abcd1234.jpg" } — the part after /uploads/. Resolved
// against "public_html/uploads/" and checked to stay inside it so a crafted
// "../../.." path can never delete anything outside the uploads folder.
app.post('/delete', express.json(), checkAuth, async (req, res) => {
  const relPath = req.body?.path;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ error: 'Missing path' });
  }
  const normalized = path.posix.normalize(`public_html/uploads/${relPath}`);
  if (!normalized.startsWith('public_html/uploads/') || normalized.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    await withFtp(async (client) => {
      try {
        await client.remove(normalized);
      } catch (err) {
        // Already gone still counts as success — the end state we want is achieved.
        if (!/no such file|not found|550/i.test(err.message || '')) throw err;
      }
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[delete] failed:', err.message);
    return res.status(500).json({ error: 'Delete failed', detail: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`media-upload-service listening on 0.0.0.0:${PORT}`);
});
