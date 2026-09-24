// media.gobike.au upload+transcode service
// - video -> saved raw immediately (URL is final right away), then
//   transcoded (H.264/AAC MP4) by a background queue worker — see the
//   "ASYNC VIDEO TRANSCODE QUEUE" section below for why.
// - image -> compressed synchronously (fast enough not to need queuing).
// Auth: shared-secret header (x-upload-secret), matches UPLOAD_SECRET env var.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 39281;
const SECRET = process.env.UPLOAD_SECRET || '';
const PUBLIC_HTML = path.join(__dirname, '..', 'public_html', 'uploads');
const TMP_DIR = path.join(__dirname, 'tmp');
// Untouched copy of every upload, kept as a backup before any compression/
// transcode happens — a sibling of public_html (NOT inside it), so these
// never become web-accessible by URL. Some of what lands here (warranty
// claim photos, affiliate KYC docs) shouldn't be guessable/public.
const ORIGINALS_DIR = path.join(__dirname, '..', 'originals');
// Next.js app's webhook — told once, per-video, when background transcoding
// finishes, so it can update Media.qualityScore / transcodePending. Best-
// effort: if this fails, the video itself is still fully fine (already
// transcoded in place), only the admin-UI quality badge would stay stale.
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://gobike.au/api/media/upload/hostinger-callback';

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(path.join(PUBLIC_HTML, 'video'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_HTML, 'image'), { recursive: true });
fs.mkdirSync(path.join(ORIGINALS_DIR, 'video'), { recursive: true });
fs.mkdirSync(path.join(ORIGINALS_DIR, 'image'), { recursive: true });

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB cap

function checkAuth(req, res, next) {
  const provided = req.header('x-upload-secret');
  if (!SECRET || provided !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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
function uniqueName(dir, ext, originalFilename) {
  const slug = slugify(originalFilename);
  if (!slug) return crypto.randomBytes(16).toString('hex') + ext; // no usable original name at all

  const plain = slug + ext;
  if (!fs.existsSync(path.join(dir, plain))) return plain;

  for (let i = 1; i < 1000; i++) {
    const candidate = `${slug}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${slug}-${crypto.randomBytes(4).toString('hex')}${ext}`; // extreme fallback, practically unreachable
}

// Copies the untouched upload into ORIGINALS_DIR before compression/transcode
// ever touches it — pure backup, never read back by this service. Best-effort
// and non-fatal: a backup failing must never block the actual upload the
// customer/admin is waiting on.
function backupOriginal(tmpPath, type, folder, originalFilename) {
  try {
    const dir = path.join(ORIGINALS_DIR, type, folder);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(originalFilename) || '';
    const name = uniqueName(dir, ext, originalFilename);
    fs.copyFileSync(tmpPath, path.join(dir, name));
  } catch (err) {
    console.error('[backup] failed to save original (upload itself is unaffected):', err.message);
  }
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

app.get('/health', (req, res) => res.json({ ok: true, ffmpeg: !!ffmpegPath, queue: queue.length }));

// uploads/ ফোল্ডারের মোট সাইজ + ফাইল সংখ্যা রিপোর্ট করে — admin media
// widget-এ Hostinger-এর storage ব্যবহার দেখানোর জন্য। পুরো account-এর disk
// না, শুধু আমাদের uploads/ ফোল্ডারের হিসাব — বেশি প্রাসঙ্গিক (একই account-এ
// অন্য domain-ও আছে)।
function dirStats(dir) {
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          totalBytes += fs.statSync(full).size;
          fileCount++;
        } catch { /* file vanished mid-scan, ignore */ }
      }
    }
  }
  return { totalBytes, fileCount };
}

app.get('/stats', checkAuth, (req, res) => {
  const stats = dirStats(PUBLIC_HTML);
  res.json({ ok: true, ...stats });
});

// ─── ASYNC VIDEO TRANSCODE QUEUE ────────────────────────────────────────────
// Why: transcoding a real-world video (a few minutes of 4K phone footage) can
// take multiple minutes on this shared host's ~2 usable cores — long enough
// to hit the PHP bridge's execution-time ceiling (confirmed: LiteSpeed
// max_execution_time=300s) and, worse, to leave a browser upload spinner
// stuck for minutes with the user unsure if it's frozen. So the /upload
// video path now: (1) saves the ORIGINAL bytes straight to the FINAL public
// URL and responds immediately — the video is playable right away, just not
// yet compressed; (2) queues a transcode job. A background worker (this
// same always-on PM2 process) works through the queue one job at a time
// (respecting the same 2-core reality that motivated -threads 2 elsewhere),
// and once done, atomically swaps the compressed file in AT THE SAME PATH —
// fs.renameSync on the same filesystem is atomic, so a viewer mid-download
// of the old file is unaffected, and the URL never changes (no DB update
// needed for the URL itself, ever).
//
// The queue is persisted to disk (QUEUE_FILE) so a PM2/server restart never
// silently drops a pending job — on boot we reload whatever was left and
// resume. Failed jobs retry up to MAX_ATTEMPTS times (transient network/host
// hiccups shouldn't permanently strand a video un-compressed); a job that
// still fails after that is moved to FAILED_FILE for manual attention and
// removed from the active queue so it can't block everything behind it —
// the raw (uncompressed but fully playable) video stays live in the
// meantime either way.
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

  const tmpOut = job.rawPath + '.transcoding.mp4';
  try {
    const args = [
      '-y', '-threads', '2', '-i', job.rawPath,
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
    // (confirmed: PM2 uptime reset, job had to restart from scratch, twice,
    // on the very first real-world video). slow already proved reliable
    // (all 54 migrated videos succeeded on it) and finishes in a fraction of
    // the time — better to actually complete than to chase marginally
    // better compression and risk never finishing.
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.slice(-2000) || err.message));
        resolve();
      });
    });

    const qualityScore = await computeVMAF(tmpOut, job.rawPath);
    const newSize = fs.statSync(tmpOut).size;

    // Poster thumbnail — the frontend (MediaCarousel.tsx) expects one at
    // this exact sibling path (video URL with its extension swapped for
    // .jpg — a convention carried over from Cloudinary, which auto-generated
    // one there). "thumbnail" picks a representative non-black/non-fade
    // frame from an early sample window, rather than just grabbing frame 0.
    const posterPath = job.rawPath.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
    try {
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
          '-y', '-i', tmpOut,
          '-vf', "thumbnail,scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
          '-frames:v', '1',
          posterPath,
        ], { maxBuffer: 1024 * 1024 * 20 }, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      console.error(`[queue] poster generation failed for ${job.url} (non-fatal):`, err.message);
    }

    // Atomic on the same filesystem — a viewer mid-stream of the raw file
    // keeps reading the old inode's data uninterrupted; new requests after
    // this instant get the compressed file. Same path/URL throughout.
    fs.renameSync(tmpOut, job.rawPath);

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
      console.error(`[queue] GIVING UP after ${MAX_ATTEMPTS} attempts: ${job.url} — raw file stays live, uncompressed. Needs manual look.`);
    }
    saveQueue();
  } finally {
    workerBusy = false;
  }

  if (queue.length > 0) setImmediate(processQueue); // more waiting — keep going
}

// Safety net: catches anything the immediate kick missed (e.g. jobs reloaded
// from disk on a fresh process start).
setInterval(processQueue, 60 * 1000);
processQueue(); // resume whatever was left in the queue from before a restart

app.post('/upload', checkAuth, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });

  const isVideo = (file.mimetype || '').startsWith('video/');
  const folder = req.body.folder && /^[a-z0-9_-]+$/i.test(req.body.folder) ? req.body.folder : 'general';

  try {
    if (isVideo) {
      // Final filename/URL decided right now and never changes — the
      // background worker later overwrites these exact bytes in place. See
      // the "ASYNC VIDEO TRANSCODE QUEUE" comment above for the full why.
      const outDir = path.join(PUBLIC_HTML, 'video', folder);
      fs.mkdirSync(outDir, { recursive: true });
      const outName = uniqueName(outDir, '.mp4', file.originalname);
      const outPath = path.join(outDir, outName);

      fs.copyFileSync(file.path, outPath); // raw bytes, playable immediately
      backupOriginal(file.path, 'video', folder, file.originalname);
      fs.unlink(file.path, () => {});

      const url = `https://media.gobike.au/uploads/video/${folder}/${outName}`;
      enqueue({ url, rawPath: outPath, folder, originalSize: file.size });

      return res.json({
        success: true, url, type: 'video',
        qualityScore: null, transcodePending: true,
        size: file.size, originalSize: file.size, // same for now — the callback updates `size` once compressed
      });
    } else {
      const outDir = path.join(PUBLIC_HTML, 'image', folder);
      fs.mkdirSync(outDir, { recursive: true });

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
          const outName = uniqueName(outDir, '.webp', file.originalname);
          const outPath = path.join(outDir, outName);
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

          backupOriginal(file.path, 'image', folder, file.originalname);
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
      const rawName = uniqueName(outDir, ext, file.originalname);
      const rawPath = path.join(outDir, rawName);
      fs.copyFileSync(file.path, rawPath);
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
// and checked to stay inside PUBLIC_HTML so a crafted "../../.." path can
// never delete anything outside the uploads folder.
app.post('/delete', express.json(), checkAuth, (req, res) => {
  const relPath = req.body?.path;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ error: 'Missing path' });
  }
  const target = path.resolve(PUBLIC_HTML, relPath);
  if (!target.startsWith(PUBLIC_HTML + path.sep)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  fs.unlink(target, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('[delete] failed:', err.message);
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
    // ENOENT (already gone) still counts as success — the end state we want is achieved
    return res.json({ success: true });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`media-upload-service listening on 127.0.0.1:${PORT}`);
});
