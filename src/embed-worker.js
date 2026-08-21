/**
 * Embedding Web Worker
 *
 * Runs all-MiniLM-L6-v2 (Xenova/all-MiniLM-L6-v2, ONNX) via Transformers.js
 * inside a dedicated worker so inference never blocks the UI thread.
 *
 * Backend selection: WebGPU (fp16) when navigator.gpu is available, otherwise
 * WASM (q8). If pipeline creation fails on WebGPU, fall back to WASM and
 * report the downgrade via status().
 *
 * Message protocol (main thread -> worker):
 *   { id: number, action: string, params: object }
 * Response (worker -> main thread):
 *   { id: number, ok: true, result: any } | { id: number, ok: false, error: string }
 * Unsolicited progress messages (model download):
 *   { type: 'progress', ...progressPayload }
 *
 * URL parameters (set by src/lib/embeddings.js):
 *   ?backend=wasm|webgpu  Force a backend (used for deterministic testing)
 *   ?models=/models/      Base URL for locally served model files
 *   ?ort=/ort/            Base URL for locally served ONNX Runtime wasm files
 *
 * Bundled as a separate webpack entry (chunkLoading: 'import-scripts'); do NOT
 * load through the classic inline-worker transform (this file imports an npm
 * module).
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;

/** @type {object|null} The initialized feature-extraction pipeline */
let extractor = null;

/** @type {string|null} The active backend: 'webgpu' or 'wasm' */
let backend = null;

/** @type {string|null} The active dtype: 'fp16' or 'q8' */
let dtype = null;

/**
 * Forward a Transformers.js download progress event to the main thread.
 *
 * @param {object} progress - Progress payload from the pipeline
 * @returns {void}
 */
function reportProgress(progress) {
  self.postMessage({ type: 'progress', ...progress });
}

/**
 * Detect WebGPU availability.
 *
 * Some browsers expose navigator.gpu but reject adapter requests, so we treat
 * adapter acquisition as part of the probe.
 *
 * @returns {Promise<boolean>}
 */
async function hasWebGPU() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Initialize the embedding pipeline.
 *
 * Tries WebGPU/fp16 first (when available), then falls back to WASM/q8.
 * Download progress is streamed to the main thread. The backend used is
 * stored so status() can report it.
 *
 * Model files are loaded from the local base URL given by the ?models= URL
 * parameter (default '/models/') when present; remote loading from the
 * Hugging Face hub stays enabled as a fallback so the component still works
 * when the host app does not serve the model files.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
  // Load Transformers.js dynamically inside the worker so webpack bundles
  // the dependency into the worker chunk instead of emitting a bare module
  // specifier that the browser cannot resolve.
  const transformers = await import('@huggingface/transformers');
  const pipeline = transformers.pipeline;
  const env = transformers.env;

  const urlParams = new URLSearchParams(self.location?.search ?? '');
  const backendOverride = urlParams.get('backend');

  // Prefer locally served model files (downloaded by this package's
  // postinstall script), with the Hugging Face hub as fallback.
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.localModelPath = urlParams.get('models') ?? '/models/';

  // Serve ORT wasm binaries locally instead of fetching from a CDN.
  env.backends.onnx.wasm.wasmPaths = urlParams.get('ort') ?? '/ort/';

  const attempts = [];

  if (backendOverride === 'webgpu') {
    attempts.push({ device: 'webgpu', dtype: 'fp16' });
  } else if (backendOverride === 'wasm') {
    attempts.push({ device: 'wasm', dtype: 'q8' });
  } else {
    const webgpuAvailable = await hasWebGPU();
    if (webgpuAvailable) {
      attempts.push({ device: 'webgpu', dtype: 'fp16' });
    }
    attempts.push({ device: 'wasm', dtype: 'q8' });
  }

  for (const attempt of attempts) {
    try {
      extractor = await pipeline('feature-extraction', MODEL_ID, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: reportProgress,
      });
      backend = attempt.device;
      dtype = attempt.dtype;
      return;
    } catch (error) {
      console.warn(`[embed-worker] Failed to create pipeline with ${attempt.device}/${attempt.dtype}:`, error.message);
      if (attempt === attempts[attempts.length - 1]) {
        throw error;
      }
    }
  }
}

/**
 * Action handlers. Each receives the message `params` object and returns
 * a structured-clone-safe result.
 */
const actions = {
  /**
   * Report backend, dtype, model id, and readiness.
   *
   * @returns {{backend: string, dtype: string, model: string, ready: boolean, dims: number}}
   */
  status() {
    return {
      backend,
      dtype,
      model: MODEL_ID,
      ready: extractor !== null,
      dims: EMBEDDING_DIMS,
    };
  },

  /**
   * Embed one or more texts.
   *
   * @param {{texts: string[]}} params
   * @returns {Promise<number[][]>} One 384-dim normalized vector per text
   */
  async embed({ texts }) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('embed expects a non-empty array of strings');
    }
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  },

  /**
   * Release the pipeline so the model runtime can be garbage-collected.
   *
   * ORT sessions and tokenizers hold wasm/GPU memory that the JS garbage
   * collector cannot see; call their dispose() methods when present, then
   * drop the reference. After dispose, the next embed lazily re-initializes.
   * The main thread normally follows this with worker.terminate(), which is
   * what guarantees the whole runtime is freed.
   *
   * @returns {Promise<{disposed: boolean}>}
   */
  async dispose() {
    const hadExtractor = extractor !== null;
    if (extractor) {
      // Best-effort native cleanup; not all pipeline stages expose dispose().
      try {
        extractor.model?.dispose?.();
        extractor.tokenizer?.dispose?.();
      } catch (error) {
        console.warn('[embed-worker] Error while disposing pipeline:', error.message);
      }
    }
    extractor = null;
    backend = null;
    dtype = null;
    return { disposed: hadExtractor };
  },
};

/** Initialization promise: every message awaits this before touching the model. */
let ready = initialize();

/**
 * Message handler. Dispatches to the action handlers above and always
 * answers with the matching message id so the main thread can correlate
 * requests and responses.
 *
 * @param {MessageEvent} event - { id, action, params }
 * @returns {Promise<void>}
 */
self.onmessage = async (event) => {
  const data = event.data || {};
  const { id, action, params = {} } = data;
  // Ignore non-protocol messages (e.g. webpack dev-server HMR broadcasts).
  if (typeof id !== 'number' || typeof action !== 'string') {
    return;
  }

  try {
    if (action !== 'dispose') {
      // After a dispose(), the next real action re-initializes the pipeline.
      if (extractor === null) {
        ready = initialize();
      }
      await ready;
    }

    if (typeof actions[action] !== 'function') {
      throw new Error(`Unknown embed-worker action: ${action}`);
    }

    const result = await actions[action](params);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};

/**
 * Error handler for uncaught exceptions inside the worker.
 * Without this, worker errors fail silently from the main thread.
 */
self.onerror = (error) => {
  console.error('[embed-worker] Unhandled error:', error);
};
