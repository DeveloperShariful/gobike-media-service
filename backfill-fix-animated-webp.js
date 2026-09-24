// backfill-fix-animated-webp.js
// One-time repair (2026-09-22): server.js's image-compression ffmpeg command
// was missing -frames:v 1, so any "motion photo" (Samsung/Google/some Live
// Photo JPEGs with a short clip embedded in the same file) got encoded as a
// 2-frame animated WebP instead of a plain photo — frame 1 is the real,
// correctly-colored image; frame 2 is a broken/dark frame pulled from the
// embedded clip. Browsers that autoplay WebP animation settle on frame 2
// (loop:1), which is the "photo turned black/grayscale" bug reported.
//
// Fix: for every existing .webp under uploads/image, detect the animated
// (VP8X + ANIM flag) ones and re-save with just frame 0 — no quality loss
// versus what should have been served, no source file needed.
//
// Usage: node backfill-fix-animated-webp.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const UPLOADS_IMAGE_DIR = path.join(__dirname, '..', 'public_html', 'uploads', 'image');
const DRY_RUN = process.argv.includes('--dry-run');

function isAnimatedWebp(buf) {
  if (buf.length < 21) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  if (buf.toString('ascii', 12, 16) !== 'VP8X') return false;
  const flags = buf.readUInt8(20);
  return !!(flags & 0x02); // ANIM bit
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.toLowerCase().endsWith('.webp')) out.push(p);
  }
}

function extractFrame0(file) {
  const tmp = file + '.fixing.webp';
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-y', '-i', file, '-frames:v', '1', tmp], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-500) || err.message));
      resolve(tmp);
    });
  });
}

(async () => {
  const files = [];
  walk(UPLOADS_IMAGE_DIR, files);
  console.log(`Scanning ${files.length} .webp files under ${UPLOADS_IMAGE_DIR} ...`);

  const affected = [];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(f, { flag: 'r' }).subarray(0, 32);
      if (isAnimatedWebp(buf)) affected.push(f);
    } catch (err) {
      console.error(`READ ERROR: ${f}: ${err.message}`);
    }
  }

  console.log(`\nFound ${affected.length} broken (animated) webp file(s) out of ${files.length} total.`);
  if (DRY_RUN) {
    affected.forEach(f => console.log('  would fix:', f));
    console.log('\n--dry-run: no files modified.');
    return;
  }

  let fixed = 0;
  const errors = [];
  for (const f of affected) {
    try {
      const tmp = await extractFrame0(f);
      const newBuf = fs.readFileSync(tmp).subarray(0, 32);
      if (isAnimatedWebp(newBuf)) throw new Error('still animated after fix — aborting replace for this file');
      fs.renameSync(tmp, f);
      fixed++;
      console.log(`FIXED: ${f}`);
    } catch (err) {
      errors.push({ file: f, error: err.message });
      console.error(`ERROR fixing ${f}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${fixed}/${affected.length} fixed, ${errors.length} error(s).`);
  if (errors.length) {
    fs.writeFileSync(path.join(__dirname, 'backfill-fix-errors.json'), JSON.stringify(errors, null, 2));
    console.log('Error details written to backfill-fix-errors.json');
  }
})();
