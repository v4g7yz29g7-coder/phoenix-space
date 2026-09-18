'use strict';

/**
 * sensors/video_sampler.js
 * =============================================================================
 * Извлечение кадров из видеофайлов (mp4 и др.) через ffmpeg.
 *
 * Публичный API:
 *   sampleFrames(videoPath, stepSec, options) -> Promise<string[]>
 *       Возвращает массив путей к извлечённым PNG-кадрам.
 *
 *   sampleFramesSync(videoPath, stepSec, options) -> string[]   (блокирующий)
 *   probe(videoPath, options)        -> Promise<VideoInfo>
 *   describe(dir)                    -> { dir, count, frames, bytes }
 *   cleanup(dir)                     -> void            (рекурсивное удаление)
 *   createSampler(options)           -> VideoSampler
 *   checkAvailability(options)       -> { available, ffmpeg, ffprobe }
 *   buildTimestamps(duration, step)  -> number[]
 *   capabilities()                   -> Promise<object>
 *
 * VideoInfo:
 *   {
 *     path, duration, width, height, fps, codec, bitrate, sizeBytes, raw
 *   }
 *
 * Возможности:
 *   - валидация входного файла (существование, непустой, расширение);
 *   - определение длительности/разрешения/кодека через ffprobe (опционально);
 *   - два режима извлечения:
 *       'fps'  — фильтр `fps=1/step` (быстро, кадры на регулярной сетке);
 *       'seek' — точный поиск по списку таймстемпов (`-ss` перед `-i`);
 *   - настраиваемый масштаб (scale), частота (fps), формат кадра (png/jpg);
 *   - таймаут выполнения, ограничение максимального количества кадров;
 *   - аккуратная обработка ошибок spawn/ffmpeg (класс VideoSamplerError);
 *   - имена кадров в детерминированном виде: frame_000001.png, ...
 *   - безопасная временная директория по умолчанию (os.tmpdir()).
 *
 * Зависимости: только Node.js core (fs, path, os, child_process) + бинарник
 * ffmpeg/ffprobe из PATH.
 * =============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Поддерживаемые расширения видео, которые имеет смысл пробовать сэмплировать. */
const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg',
  '.mpeg', '.ts', '.m2ts', '.3gp', '.ogv',
];

/** Форматы выходных кадров и их расширения. */
const IMAGE_FORMATS = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };

/** Ошибка модуля с дополнительными деталями выполнения. */
class VideoSamplerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VideoSamplerError';
    this.details = details;
  }
}

/**
 * Нормализует stepSec: строка/число -> положительное конечное число секунд.
 * @param {number|string} stepSec
 * @returns {number}
 */
function normalizeStep(stepSec) {
  let value;
  if (stepSec === undefined || stepSec === null || stepSec === '') {
    value = 1;
  } else if (typeof stepSec === 'number') {
    value = stepSec;
  } else {
    value = parseFloat(String(stepSec));
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new VideoSamplerError(
      `stepSec must be a positive finite number, got: ${JSON.stringify(stepSec)}`,
      { stepSec },
    );
  }
  return value;
}

/** Проверяет существование и непустоту файла. */
function assertReadableFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new VideoSamplerError('videoPath must be a non-empty string', { filePath });
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new VideoSamplerError(`video file not found: ${filePath}`, {
      filePath,
      cause: err && err.message,
    });
  }
  if (!stat.isFile()) {
    throw new VideoSamplerError(`not a regular file: ${filePath}`, { filePath });
  }
  if (stat.size === 0) {
    throw new VideoSamplerError(`video file is empty: ${filePath}`, { filePath });
  }
  return stat;
}

/** Гарантирует существование директории. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Строит сетку таймстемпов [0, step, 2*step, ...] длиной <= maxFrames.
 * @param {number} duration длительность в секундах
 * @param {number} stepSec шаг в секундах
 * @param {number} [maxFrames=Infinity]
 * @returns {number[]}
 */
function buildTimestamps(duration, stepSec, maxFrames = Infinity) {
  const step = normalizeStep(stepSec);
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const out = [];
  const limit = Math.min(Number.isFinite(maxFrames) ? maxFrames : Infinity, 100000);
  for (let t = 0; t < duration && out.length < limit; t += step) {
    out.push(Number(t.toFixed(6)));
  }
  return out;
}

/**
 * Запускает бинарник и собирает stdout/stderr, учитывая timeout.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runBinary(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout && options.timeout > 0 ? options.timeout : 0;
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      return reject(new VideoSamplerError(`failed to spawn ${bin}: ${err.message}`, {
        bin, args, cause: err && err.message,
      }));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        finish(reject, new VideoSamplerError(`${bin} timed out after ${timeout}ms`, {
          bin, args, stderr,
        }));
      }, timeout);
    }

    child.on('error', (err) => {
      finish(reject, new VideoSamplerError(`failed to run ${bin}: ${err.message}`, {
        bin, args, cause: err && err.message,
      }));
    });

    child.on('close', (code) => {
      finish(resolve, { code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/**
 * Проверяет наличие ffmpeg/ffprobe в PATH.
 * @returns {Promise<{available:boolean, ffmpeg:string, ffprobe:string, ffmpegOk:boolean, ffprobeOk:boolean}>}
 */
async function checkAvailability(options = {}) {
  const ffmpeg = options.ffmpegPath || DEFAULT_FFMPEG;
  const ffprobe = options.ffprobePath || DEFAULT_FFPROBE;
  const [a, b] = await Promise.all([
    runBinary(ffmpeg, ['-version'], { timeout: 10000 }).catch(() => null),
    runBinary(ffprobe, ['-version'], { timeout: 10000 }).catch(() => null),
  ]);
  return {
    available: Boolean(a && a.code === 0),
    ffmpeg,
    ffprobe,
    ffmpegOk: Boolean(a && a.code === 0),
    ffprobeOk: Boolean(b && b.code === 0),
  };
}

/** Разбирает долю вида "30000/1001" или "25" в число. */
function parseRational(ratio) {
  if (ratio === undefined || ratio === null) return 0;
  const s = String(ratio);
  if (s.includes('/')) {
    const [num, den] = s.split('/').map((x) => parseFloat(x));
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
    return 0;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Получает метаданные видео через ffprobe. При отсутствии ffprobe пытается
 * упасть обратно на разбор длительности, отсутствие данных не фатально.
 * @returns {Promise<object>}
 */
async function probe(videoPath, options = {}) {
  const stat = assertReadableFile(videoPath);
  const ffprobe = options.ffprobePath || DEFAULT_FFPROBE;
  const empty = {
    path: videoPath,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: null,
    bitrate: 0,
    sizeBytes: stat.size,
    raw: null,
  };

  let res;
  try {
    res = await runBinary(ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ], { timeout: options.timeout || 30000 });
  } catch (_) {
    return empty;
  }
  if (!res || res.code !== 0) return empty;

  let json;
  try {
    json = JSON.parse(res.stdout || '{}');
  } catch (_) {
    return empty;
  }

  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') || {};
  const format = json.format || {};
  const duration = parseFloat(format.duration || video.duration || '0') || 0;
  return {
    path: videoPath,
    duration,
    width: video.width || 0,
    height: video.height || 0,
    fps: parseRational(video.avg_frame_rate || video.r_frame_rate),
    codec: video.codec_name || null,
    bitrate: parseInt(format.bit_rate || '0', 10) || 0,
    sizeBytes: stat.size,
    raw: json,
  };
}

/**
 * Основная функция: извлекает кадры из видео с шагом stepSec секунд.
 * @param {string} videoPath путь к видеофайлу
 * @param {number|string} stepSec шаг между кадрами в секундах
 * @param {object} [options]
 * @param {string} [options.outDir] директория вывода (по умолчанию tmp)
 * @param {'fps'|'seek'} [options.mode='fps'] стратегия извлечения
 * @param {string} [options.format='png'] формат кадра
 * @param {string} [options.scale] напр. '320:-1'
 * @param {number} [options.maxFrames] ограничение кол-ва кадров
 * @param {number} [options.timeout=120000] таймаут на процесс ffmpeg
 * @param {number} [options.start=0] стартовая секунда
 * @param {number} [options.end] конечная секунда
 * @param {number[]} [options.timestamps] явные таймстемпы (режим seek)
 * @returns {Promise<string[]>} отсортированные пути к PNG-кадрам
 */
async function sampleFrames(videoPath, stepSec, options = {}) {
  const step = normalizeStep(stepSec);
  assertReadableFile(videoPath);

  const format = String(options.format || 'png').toLowerCase();
  if (!IMAGE_FORMATS[format]) {
    throw new VideoSamplerError(`unsupported frame format: ${format}`, { format });
  }
  const ext = IMAGE_FORMATS[format];

  const outDir = options.outDir
    ? ensureDir(path.resolve(options.outDir))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'video-sampler-'));

  const maxFrames = options.maxFrames && options.maxFrames > 0
    ? Math.floor(options.maxFrames)
    : 0;

  const mode = options.mode === 'seek' ? 'seek' : 'fps';
  const ffmpeg = options.ffmpegPath || DEFAULT_FFMPEG;
  const timeout = options.timeout && options.timeout > 0 ? options.timeout : 120000;
  const start = Number.isFinite(options.start) && options.start > 0 ? options.start : 0;

  const pattern = path.join(outDir, `frame_%06d.${ext}`);
  const commonTail = [];
  if (options.scale) commonTail.push('-vf', `scale=${options.scale}`);

  let args;
  if (mode === 'seek') {
    let timestamps = Array.isArray(options.timestamps) && options.timestamps.length
      ? options.timestamps.slice()
      : buildTimestamps(await durationOrZero(videoPath, options), step, maxFrames || Infinity);
    if (maxFrames > 0) timestamps = timestamps.slice(0, maxFrames);
    if (timestamps.length === 0) timestamps = [0];

    // Батч-извлечение: один ffmpeg на кадр через -ss перед -i (быстрый seek).
    const results = [];
    for (const t of timestamps) {
      const single = path.join(outDir, `frame_${String(results.length + 1).padStart(6, '0')}.${ext}`);
      const singleArgs = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(t),
        '-i', videoPath,
        '-frames:v', '1',
      ];
      if (options.scale) singleArgs.push('-vf', `scale=${options.scale}`);
      singleArgs.push(single);
      const r = await runBinary(ffmpeg, singleArgs, { timeout });
      if (r.code === 0 && fs.existsSync(single)) results.push(single);
      else if (!options.ignoreErrors) {
        throw new VideoSamplerError(`ffmpeg failed for timestamp ${t}`, {
          videoPath, timestamp: t, stderr: (r && r.stderr || '').slice(-2000),
        });
      }
    }
    return results;
  }

  // Режим 'fps': один прогон ffmpeg с фильтром fps=1/step.
  args = [
    '-hide_banner', '-loglevel', 'error', '-y',
  ];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', videoPath);
  const filters = [`fps=1/${step}`];
  if (options.scale) filters.push(`scale=${options.scale}`);
  args.push('-vf', filters.join(','));
  if (maxFrames > 0) args.push('-frames:v', String(maxFrames));
  args.push(pattern);

  const res = await runBinary(ffmpeg, args, { timeout });
  if (res.code !== 0) {
    throw new VideoSamplerError('ffmpeg failed to extract frames', {
      videoPath, code: res.code, stderr: (res.stderr || '').slice(-4000),
    });
  }

  return listFrames(outDir, ext);
}

/** Возвращает длительность либо 0, если ffprobe недоступен. */
async function durationOrZero(videoPath, options) {
  try {
    const info = await probe(videoPath, options);
    return info.duration || 0;
  } catch (_) {
    return 0;
  }
}

/** Список кадров в директории, отсортированный по имени. */
function listFrames(outDir, ext) {
  let names;
  try {
    names = fs.readdirSync(outDir);
  } catch (_) {
    return [];
  }
  const suffix = `.${ext}`;
  return names
    .filter((n) => n.endsWith(suffix))
    .sort()
    .map((n) => path.join(outDir, n));
}

/** Рекурсивно удаляет директорию с кадрами. */
function cleanup(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

/** Описывает содержимое директории с кадрами. */
function describe(dir) {
  let frames = [];
  let bytes = 0;
  try {
    frames = fs.readdirSync(dir)
      .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
      .sort()
      .map((n) => path.join(dir, n));
    for (const f of frames) {
      try { bytes += fs.statSync(f).size; } catch (_) { /* ignore */ }
    }
  } catch (_) {
    frames = [];
  }
  return { dir, count: frames.length, frames, bytes };
}

/** Синхронная обёртка над асинхронной нельзя напрямую — используем deasync-стиль
 *  через spawnSync недоступен, поэтому реализован отдельный простой путь. */
function sampleFramesSync(videoPath, stepSec, options = {}) {
  const { spawnSync } = require('child_process');
  const step = normalizeStep(stepSec);
  assertReadableFile(videoPath);
  const format = String(options.format || 'png').toLowerCase();
  const ext = IMAGE_FORMATS[format] || 'png';
  const outDir = options.outDir
    ? ensureDir(path.resolve(options.outDir))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'video-sampler-'));
  const ffmpeg = options.ffmpegPath || DEFAULT_FFMPEG;
  const pattern = path.join(outDir, `frame_%06d.${ext}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (options.start > 0) args.push('-ss', String(options.start));
  args.push('-i', videoPath, '-vf', `fps=1/${step}`);
  if (options.maxFrames > 0) args.push('-frames:v', String(options.maxFrames));
  args.push(pattern);
  const res = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new VideoSamplerError('ffmpeg sync failed', {
      videoPath, stderr: (res.stderr || '').slice(-2000),
    });
  }
  return listFrames(outDir, ext);
}

/** Фабрика объекта-сэмплера с зафиксированными опциями. */
function createSampler(defaultOptions = {}) {
  return {
    sampleFrames: (videoPath, stepSec, opts = {}) =>
      sampleFrames(videoPath, stepSec, { ...defaultOptions, ...opts }),
    sampleFramesSync: (videoPath, stepSec, opts = {}) =>
      sampleFramesSync(videoPath, stepSec, { ...defaultOptions, ...opts }),
    probe: (videoPath, opts = {}) => probe(videoPath, { ...defaultOptions, ...opts }),
    describe,
    cleanup,
    options: { ...defaultOptions },
  };
}

/** Возвращает сведения о возможностях окружения. */
async function capabilities() {
  const av = await checkAvailability();
  return {
    module: 'sensors/video_sampler',
    ffmpeg: av.ffmpeg,
    ffprobe: av.ffprobe,
    available: av.available,
    ffprobeOk: av.ffprobeOk,
    formats: Object.keys(IMAGE_FORMATS),
    modes: ['fps', 'seek'],
    extensions: VIDEO_EXTENSIONS.slice(),
  };
}

module.exports = {
  sampleFrames,
  sampleFramesSync,
  probe,
  describe,
  cleanup,
  createSampler,
  checkAvailability,
  capabilities,
  buildTimestamps,
  normalizeStep,
  listFrames,
  runBinary,
  VideoSamplerError,
  VIDEO_EXTENSIONS,
  IMAGE_FORMATS,
};
