/**
 * Model Download Script (postinstall)
 *
 * Downloads the Xenova/all-MiniLM-L6-v2 model files into models/ and
 * copies the ONNX Runtime Web binaries from node_modules into ort/, so
 * the embedding worker can run fully local — no runtime fetch from the
 * Hugging Face hub or the jsdelivr CDN.
 *
 * Behavior:
 *   - Idempotent: files already present with the expected size are skipped.
 *   - Opt-out: set GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1 to skip entirely
 *     (e.g. in CI; the component then falls back to downloading from the
 *     Hugging Face hub into the browser's Cache Storage at runtime).
 *   - Non-fatal: network failures print a warning and exit 0 so an
 *     `npm install` behind a firewall does not fail; the runtime fallback
 *     above keeps the component working.
 *   - Hoisting-aware: onnxruntime-web is located via Node's standard module
 *     resolution, so hoisted (npm/yarn), nested, and pnpm layouts all work.
 *
 * Usage: node scripts/download-model.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

/** Model files required by the feature-extraction pipeline (q8 + fp16 weights). */
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
  'onnx/model_fp16.onnx',
];

/** Directory the model is downloaded into: models/Xenova/all-MiniLM-L6-v2/ */
const modelDir = path.join(packageRoot, 'models', MODEL_ID);

/** Directory the ORT wasm/mjs runtime files are copied into. */
const ortDir = path.join(packageRoot, 'ort');

/**
 * Get the remote size of a model file via HEAD request.
 *
 * @param {string} url - The file URL
 * @returns {Promise<number|null>} Content length, or null if unknown
 */
async function remoteSize(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok) {
      return null;
    }
    const length = response.headers.get('content-length');
    return length === null ? null : parseInt(length, 10);
  } catch {
    return null;
  }
}

/**
 * Download one model file, streaming to disk.
 *
 * @param {string} relativePath - Path relative to the model root (e.g. 'onnx/model_quantized.onnx')
 * @returns {Promise<void>}
 */
async function downloadFile(relativePath) {
  const url = `${HF_BASE}/${relativePath}`;
  const destination = path.join(modelDir, relativePath);

  // Skip files already downloaded at the expected size.
  if (fs.existsSync(destination)) {
    const localSize = fs.statSync(destination).size;
    const expectedSize = await remoteSize(url);
    if (expectedSize === null || localSize === expectedSize) {
      console.log(`[download-model] Skipping ${relativePath} (already present)`);
      return;
    }
  }

  console.log(`[download-model] Downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} while downloading ${url}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const fileStream = fs.createWriteStream(destination);
  const reader = response.body.getReader();

  // Stream the response to disk so multi-megabyte weights never sit in memory.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!fileStream.write(value)) {
      await new Promise((resolve) => fileStream.once('drain', resolve));
    }
  }
  await new Promise((resolve, reject) => {
    fileStream.end((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Locate the installed onnxruntime-web dist directory using Node's standard
 * module resolution. Unlike a hardcoded node_modules path, this also finds
 * hoisted (typical consumer installs) and pnpm layouts.
 *
 * @param {string} [fromDir] - Directory to resolve from (defaults to the package root)
 * @returns {string|null} Absolute path to onnxruntime-web/dist, or null if not installed
 */
export function findOrtSource(fromDir = packageRoot) {
  try {
    const require = createRequire(path.join(fromDir, 'package.json'));
    const entryPath = require.resolve('onnxruntime-web');

    // Walk up from the resolved entry (…/onnxruntime-web/dist/ort.min.js) to
    // the directory actually named onnxruntime-web (works under pnpm too).
    let dir = path.dirname(entryPath);
    for (;;) {
      if (path.basename(dir) === 'onnxruntime-web') {
        return path.join(dir, 'dist');
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Copy the ONNX Runtime Web binaries (ort-*.wasm and their .mjs loaders)
 * from the onnxruntime-web package into ort/.
 *
 * @param {{sourceDir?: string, targetDir?: string}} [options] Overrides for tests
 * @returns {void}
 */
export function copyOrtFiles({ sourceDir, targetDir } = {}) {
  const source = sourceDir ?? findOrtSource();
  const target = targetDir ?? ortDir;
  if (!source || !fs.existsSync(source)) {
    console.warn('[download-model] onnxruntime-web not installed; skipping ORT copy.');
    console.warn('[download-model] Run `npm install` first, then re-run this script.');
    return;
  }

  fs.mkdirSync(target, { recursive: true });
  const entries = fs.readdirSync(source).filter((name) => /ort-.*\.(wasm|mjs)$/.test(name));
  for (const name of entries) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  console.log(`[download-model] Copied ${entries.length} ORT runtime files to ${target}`);
}

/**
 * Main entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  if (process.env.GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD === '1') {
    console.log('[download-model] GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1; skipping.');
    return;
  }

  copyOrtFiles();

  for (const file of MODEL_FILES) {
    await downloadFile(file);
  }
  console.log(`[download-model] ${MODEL_ID} is available in models/`);
}

// Only auto-run when invoked directly (`node scripts/download-model.js`);
// importing the module (e.g. from tests) must stay side-effect free.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    // Non-fatal: the component falls back to the Hugging Face hub at runtime.
    console.warn(`[download-model] Model download failed: ${error.message}`);
    console.warn('[download-model] The component will download the model from');
    console.warn('[download-model] huggingface.co into browser Cache Storage at runtime.');
  });
}
