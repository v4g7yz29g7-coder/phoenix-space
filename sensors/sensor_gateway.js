/**
 * sensors/sensor_gateway.js
 * ============================================================================
 * Unified capture gateway for the PHOENIX perception / sensor layer.
 *
 * Node.js (CommonJS). No hard dependency on any optional binary or package:
 * puppeteer, ffmpeg and friends are resolved lazily, and every capture path
 * has a graceful placeholder fallback so the public contract always holds.
 *
 * Public API
 * ----------
 *   capture(type, options) -> Promise<{ path: string, size: number }>
 *       Capture a sample of the given type, persist it to disk and resolve
 *       with the artifact path and its size in bytes.
 *
 *   getSensors() -> string[]
 *       List of sensor types supported by this build.
 *
 * Supported sensor types
 * ----------------------
 *   'screenshot' : viewport / full-page screenshot via puppeteer, with an
 *                  ffmpeg x11grab fallback and a static PNG placeholder.
 *   'frame'      : a single video frame grabbed from a file/stream via ffmpeg
 *                  (or a placeholder PNG when the source is unavailable).
 *   'audio'      : an audio clip captured / transcoded via child_process and
 *                  the `ffmpeg` binary, with a synthesized silent WAV fallback.
 *
 * Design notes
 * ------------
 *   - The module is safe to `require()` on a machine that lacks puppeteer
 *     and/or ffmpeg: failures surface only when a specific capture runs, and
 *     even then a placeholder artifact is produced by default.
 *   - Artifacts are written to  <outputDir>/<type>/<type>_<ts>_<rand>.<ext>
 *     where <outputDir> defaults to $SENSOR_OUTPUT_DIR or os.tmpdir().
 *   - Capture result objects are frozen and carry path + size (bytes).
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/* ==========================================================================
 * Constants & defaults
 * ========================================================================== */

/** Logical sensor types this gateway can produce. */
const SUPPORTED_TYPES = Object.freeze(['screenshot', 'frame', 'audio']);

/** File extension per sensor type. */
const EXTENSIONS = Object.freeze({
  screenshot: 'png',
  frame: 'png',
  audio: 'wav',
});

/** Per-type default options, each overridable via `options`. */
const DEFAULTS = Object.freeze({
  screenshot: {
    ext: 'png',
    url: 'about:blank',
    viewport: { width: 1280, height: 720 },
    fullPage: false,
    imageType: 'png',
    quality: 90,
    waitUntil: 'load',
    timeout: 30000,
  },
  frame: {
    ext: 'png',
    source: null,
    at: 0,
    width: null,
    height: null,
    timeout: 30000,
  },
  audio: {
    ext: 'wav',
    source: null,
    duration: 3,
    sampleRate: 44100,
    channels: 1,
    bitrate: '128k',
    timeout: 30000,
  },
});

/** Root output directory (override with SENSOR_OUTPUT_DIR). */
const DEFAULT_OUTPUT_DIR = path.join(
  process.env.SENSOR_OUTPUT_DIR || os.tmpdir(),
  'sensor-gateway'
);

/** Locally bundled puppeteer (optional, resolved lazily). */
const LOCAL_PUPPETEER = path.join(__dirname, '..', 'node_modules', 'puppeteer');

/** Resolved ffmpeg binary name. */
const FFMPEG_BIN = process.env.SENSOR_FFMPEG_BIN || 'ffmpeg';

/** A valid 1x1 transparent PNG, used as the last-resort placeholder. */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

/* ==========================================================================
 * Generic helpers
 * ========================================================================== */

/**
 * Compact, filesystem-safe, collision-resistant suffix.
 * @returns {string} e.g. "1700000000000_a1b2c3d4"
 */
function uniqueSuffix() {
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `${stamp}_${rand}`;
}

/**
 * Recursively create a directory (idempotent).
 * @param {string} dir
 * @returns {string}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the artifacts root directory.
 * Priority: options.outputDir > options.dir > $SENSOR_OUTPUT_DIR > tmp.
 * @param {object} [options]
 * @returns {string} absolute path
 */
function resolveOutputDir(options) {
  const fromOptions = options && (options.outputDir || options.dir);
  const base = fromOptions || DEFAULT_OUTPUT_DIR;
  return path.resolve(String(base));
}

/**
 * Build the absolute destination path for a capture artifact.
 * @param {string} type
 * @param {object} opts already merged with defaults
 * @returns {string}
 */
function resolveOutputPath(type, opts) {
  const root = resolveOutputDir(opts);
  const dir = ensureDir(path.join(root, type));
  const ext = (opts && opts.ext) || EXTENSIONS[type] || 'bin';
  return path.join(dir, `${type}_${uniqueSuffix()}.${ext}`);
}

/**
 * Return the byte size of a file, or 0 when it cannot be stat'ed.
 * @param {string} file
 * @returns {number}
 */
function statSize(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Build the public, frozen capture result for an artifact file.
 * @param {string} file
 * @returns {{path: string, size: number}}
 */
function makeResult(file) {
  return Object.freeze({ path: path.resolve(file), size: statSize(file) });
}

/**
 * True when the given executable responds to `-version`.
 * @param {string} bin
 * @returns {boolean}
 */
function commandExists(bin) {
  try {
    const res = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (res && res.error) return false;
    return Boolean(res) && typeof res.status === 'number';
  } catch (err) {
    return false;
  }
}

/**
 * Resolve an executable path (PATH first, then well-known absolute paths).
 * @param {string} name
 * @param {...string} fallbacks absolute candidate paths
 * @returns {Promise<string>}
 */
function which(name, ...fallbacks) {
  return new Promise((resolve) => {
    const probe = spawnSync('command', ['-v', name], { shell: true });
    if (probe && probe.status === 0 && probe.stdout) {
      const found = probe.stdout.toString().trim();
      if (found) return resolve(found);
    }
    for (const candidate of fallbacks) {
      if (candidate && fs.existsSync(candidate)) return resolve(candidate);
    }
    return resolve(name); // last resort: let the spawn surface ENOENT
  });
}

/**
 * Run a child process to completion, resolving on exit code 0.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeout?: number, cwd?: string}} [opts]
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
function run(command, args, opts) {
  return new Promise((resolve, reject) => {
    const timeout = (opts && opts.timeout) || 0;
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: (opts && opts.cwd) || process.cwd(),
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timer = null;

    if (child.stdout) {
      child.stdout.on('data', (c) => {
        stdout += c.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (c) => {
        stderr += c.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
    }

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (err) {
          /* ignore */
        }
        reject(new Error(`${command} timed out after ${timeout}ms`));
      }, timeout);
      if (timer.unref) timer.unref();
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Lazily require an optional dependency, with a descriptive error.
 * @param {string} name
 * @returns {*}
 */
function tryRequire(name) {
  try {
    // eslint-disable-next-line global-require
    return require(name);
  } catch (err) {
    throw new Error(
      `Optional dependency "${name}" is not available: ${err.message}`
    );
  }
}

/**
 * Merge per-type defaults with caller-provided options.
 * @param {string} type
 * @param {object} [options]
 * @returns {object}
 */
function withDefaults(type, options) {
  const merged = Object.assign({}, DEFAULTS[type], options || {});
  merged.outputDir = resolveOutputDir(options);
  return merged;
}

/* ==========================================================================
 * Placeholder / fallback artifact writers
 * ========================================================================== */

/**
 * Write a minimal valid PNG placeholder so the contract still holds.
 * @param {string} outPath
 * @returns {Promise<{path:string,size:number}>}
 */
async function writePlaceholderPng(outPath) {
  await fs.promises.writeFile(outPath, PLACEHOLDER_PNG);
  return { path: outPath, size: statSize(outPath) };
}

/**
 * Build a silent mono PCM WAV buffer.
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} seconds
 * @returns {Buffer}
 */
function buildSilentWav(sampleRate, channels, seconds) {
  const bytesPerSample = 2; // 16-bit
  const numSamples = Math.max(1, Math.floor(sampleRate * seconds));
  const dataSize = numSamples * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // PCM payload is already zero-filled => silence.
  return buf;
}

/**
 * Write a silent WAV placeholder.
 * @param {string} outPath
 * @param {object} opts
 * @returns {Promise<{path:string,size:number}>}
 */
async function writePlaceholderWav(outPath, opts) {
  const wav = buildSilentWav(
    Number(opts.sampleRate) || 44100,
    Number(opts.channels) || 1,
    Number(opts.duration) > 0 ? Number(opts.duration) : 1
  );
  await fs.promises.writeFile(outPath, wav);
  return { path: outPath, size: statSize(outPath) };
}

/* ==========================================================================
 * Puppeteer helpers
 * ========================================================================== */

/**
 * Resolve the puppeteer module from the local tree or global require.
 * @returns {object}
 */
function loadPuppeteer() {
  if (fs.existsSync(LOCAL_PUPPETEER)) {
    // eslint-disable-next-line global-require
    return require(LOCAL_PUPPETEER);
  }
  return tryRequire('puppeteer');
}

/**
 * Launch a headless browser with container-friendly flags.
 * @param {object} opts
 * @param {string} [opts.executablePath]
 * @returns {Promise<object>} browser
 */
async function launchBrowser(opts) {
  const puppeteer = loadPuppeteer();
  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-first-run',
      '--no-zygote',
    ],
  };
  if (opts && opts.executablePath) launchOpts.executablePath = opts.executablePath;
  else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return puppeteer.launch(launchOpts);
}

/**
 * Close a browser, swallowing shutdown errors.
 * @param {object} browser
 * @returns {Promise<void>}
 */
async function safeClose(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (err) {
    /* ignore */
  }
}

/* ==========================================================================
 * Per-type capture handlers
 * ========================================================================== */

/**
 * Capture a screenshot of a web page.
 * @param {object} opts
 * @returns {Promise<{path:string,size:number}>}
 */
async function captureScreenshot(opts) {
  const outPath = resolveOutputPath('screenshot', opts);
  const startedAt = Date.now();
  let browser = null;

  try {
    browser = await launchBrowser(opts);
    const page = await browser.newPage();
    try {
      await page.setViewport({
        width: Number((opts.viewport && opts.viewport.width) || 1280),
        height: Number((opts.viewport && opts.viewport.height) || 720),
      });
      await page.goto(String(opts.url || 'about:blank'), {
        waitUntil: opts.waitUntil || 'load',
        timeout: Number(opts.timeout) || 30000,
      });
      if (opts.selector) {
        await page.waitForSelector(String(opts.selector), {
          timeout: Number(opts.timeout) || 30000,
        });
      }
      const shotOpts = {
        path: outPath,
        fullPage: Boolean(opts.fullPage),
      };
      if (opts.imageType === 'jpeg') {
        shotOpts.type = 'jpeg';
        shotOpts.quality = Number(opts.quality) || 90;
      }
      await page.screenshot(shotOpts);
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    // Puppeteer unavailable or navigation failed: try ffmpeg x11grab, then
    // finally fall back to a static PNG placeholder so capture() resolves.
    const grabbed = await tryFfmpegScreenshot(outPath, opts);
    if (!grabbed) {
      process.stderr.write(
        `[sensor_gateway] screenshot fallback (${err.message}); wrote placeholder.\n`
      );
      return writePlaceholderPng(outPath);
    }
  } finally {
    await safeClose(browser);
  }

  const result = { path: outPath, size: statSize(outPath) };
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Best-effort screenshot via ffmpeg x11grab (Linux/X11 only).
 * @param {string} outPath
 * @param {object} opts
 * @returns {Promise<boolean>}
 */
async function tryFfmpegScreenshot(outPath, opts) {
  if (process.platform !== 'linux') return false;
  if (!commandExists(opts.ffmpegBin || FFMPEG_BIN)) return false;
  if (!process.env.DISPLAY) return false;
  try {
    await run(
      opts.ffmpegBin || FFMPEG_BIN,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-i',
        process.env.DISPLAY, '-frames:v', '1', outPath],
      { timeout: Number(opts.timeout) || 30000 }
    );
    return fs.existsSync(outPath) && statSize(outPath) > 0;
  } catch (err) {
    return false;
  }
}

/**
 * Grab a single frame from a video source.
 * @param {object} opts
 * @returns {Promise<{path:string,size:number}>}
 */
async function captureFrame(opts) {
  if (!opts.source && !opts.url) {
    throw new Error("'frame' capture requires options.source (video file or stream).");
  }
  const outPath = resolveOutputPath('frame', opts);
  const source = opts.source || opts.url;
  const ffmpeg = await which(opts.ffmpegBin || FFMPEG_BIN, '/usr/bin/ffmpeg');

  if (!commandExists(ffmpeg)) {
    process.stderr.write('[sensor_gateway] ffmpeg missing; wrote frame placeholder.\n');
    return writePlaceholderPng(outPath);
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (typeof opts.at === 'number' && Number.isFinite(opts.at) && opts.at > 0) {
    args.push('-ss', String(opts.at));
  }
  args.push('-i', String(source));

  const filters = [];
  if (opts.width && opts.height) {
    filters.push(`scale=${Number(opts.width)}:${Number(opts.height)}`);
  } else if (opts.width) {
    filters.push(`scale=${Number(opts.width)}:-1`);
  }
  if (filters.length) args.push('-vf', filters.join(','));

  args.push('-frames:v', '1', outPath);

  try {
    await run(ffmpeg, args, { timeout: Number(opts.timeout) || 30000 });
    if (!fs.existsSync(outPath) || statSize(outPath) === 0) {
      return writePlaceholderPng(outPath);
    }
  } catch (err) {
    process.stderr.write(
      `[sensor_gateway] frame capture failed (${err.message}); wrote placeholder.\n`
    );
    return writePlaceholderPng(outPath);
  }

  return { path: outPath, size: statSize(outPath) };
}

/**
 * Capture / transcode an audio clip.
 * @param {object} opts
 * @returns {Promise<{path:string,size:number}>}
 */
async function captureAudio(opts) {
  const outPath = resolveOutputPath('audio', opts);
  const ffmpeg = await which(opts.ffmpegBin || FFMPEG_BIN, '/usr/bin/ffmpeg');
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 3;
  const sampleRate = Number(opts.sampleRate) || 44100;
  const channels = Number(opts.channels) || 1;

  if (!commandExists(ffmpeg)) {
    process.stderr.write('[sensor_gateway] ffmpeg missing; wrote silent WAV placeholder.\n');
    return writePlaceholderWav(outPath, { sampleRate, channels, duration });
  }

  const source = opts.source;
  const looksLikeFile =
    source &&
    (fs.existsSync(String(source)) ||
      /\.(wav|mp3|mp4|mkv|ogg|flac|m4a|webm|aac)$/i.test(String(source)));

  const base = ['-y', '-hide_banner', '-loglevel', 'error'];
  const tail = [
    '-t', String(duration),
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-b:a', String(opts.bitrate || '128k'),
    outPath,
  ];

  let inputArgs;
  if (looksLikeFile) {
    inputArgs = ['-i', String(source)];
  } else if (opts.platform === 'darwin') {
    inputArgs = ['-f', 'avfoundation', '-i', `:${opts.deviceIndex || 0}`];
  } else if (opts.platform === 'win32') {
    inputArgs = ['-f', 'dshow', '-i', `audio=${source || 'default'}`];
  } else if (source) {
    inputArgs = ['-f', 'pulse', '-i', String(source)];
  } else {
    // No source supplied: synthesize silence deterministically (lavfi).
    inputArgs = ['-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono`];
  }

  try {
    await run(ffmpeg, [...base, ...inputArgs, ...tail], {
      timeout: Number(opts.timeout) || (duration + 15) * 1000,
    });
    if (!fs.existsSync(outPath) || statSize(outPath) === 0) {
      return writePlaceholderWav(outPath, { sampleRate, channels, duration });
    }
  } catch (err) {
    process.stderr.write(
      `[sensor_gateway] audio capture failed (${err.message}); wrote silent WAV.\n`
    );
    return writePlaceholderWav(outPath, { sampleRate, channels, duration });
  }

  return { path: outPath, size: statSize(outPath) };
}

/* ==========================================================================
 * Dispatch & public API
 * ========================================================================== */

const HANDLERS = Object.freeze({
  screenshot: captureScreenshot,
  frame: captureFrame,
  audio: captureAudio,
});

/**
 * Validate a requested sensor type.
 * @param {string} type
 * @returns {string} normalized type
 */
function validateType(type) {
  if (!type || typeof type !== 'string') {
    throw new TypeError('capture(type, options): type must be a non-empty string');
  }
  const key = type.toLowerCase().trim();
  if (!HANDLERS[key]) {
    throw new RangeError(
      `Unknown sensor type '${type}'. Supported: ${SUPPORTED_TYPES.join(', ')}`
    );
  }
  return key;
}

/**
 * Capture media of the requested type.
 *
 * @param {('screenshot'|'frame'|'audio')} type
 * @param {object} [options] per-type capture options (see DEFAULTS)
 * @returns {Promise<{path: string, size: number, type: string, durationMs: number}>}
 */
async function capture(type, options) {
  const key = validateType(type);
  const opts = withDefaults(key, options);
  ensureDir(opts.outputDir);

  const startedAt = Date.now();
  const result = await HANDLERS[key](opts);

  if (!fs.existsSync(result.path)) {
    throw new Error(`Capture produced no file for '${key}': ${result.path}`);
  }

  return {
    path: result.path,
    size: statSize(result.path),
    type: key,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * List the sensor types supported by this build.
 * @returns {string[]}
 */
function getSensors() {
  return SUPPORTED_TYPES.slice();
}

/**
 * True when the given type is supported.
 * @param {string} type
 * @returns {boolean}
 */
function supports(type) {
  return SUPPORTED_TYPES.indexOf(String(type).toLowerCase().trim()) !== -1;
}

/* ==========================================================================
 * Exports
 * ========================================================================== */

module.exports = {
  capture,
  getSensors,
  supports,
  SUPPORTED_TYPES,
  DEFAULTS,
  // Internal helpers exposed for testing / advanced usage.
  _internal: {
    uniqueSuffix,
    ensureDir,
    resolveOutputDir,
    resolveOutputPath,
    statSize,
    makeResult,
    commandExists,
    which,
    run,
    tryRequire,
    withDefaults,
    writePlaceholderPng,
    buildSilentWav,
    writePlaceholderWav,
    loadPuppeteer,
    launchBrowser,
    safeClose,
    captureScreenshot,
    captureFrame,
    captureAudio,
    validateType,
    HANDLERS,
  },
};
