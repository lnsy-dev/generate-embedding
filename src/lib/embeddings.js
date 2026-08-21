/**
 * Embeddings Client Library
 *
 * Promise-based main-thread client for the embedding worker
 * (src/embed-worker.js). All embedding access should go through this
 * module — components never talk to the worker directly.
 *
 * Lifecycle: the worker is a shared, reference-counted resource.
 * `acquireEmbedder()` creates it on first use; `releaseEmbedder()` sends a
 * `dispose` action and terminates the worker when the last consumer
 * disconnects, freeing the model runtime (ONNX wasm/WebGPU memory) so no
 * transformer sits in memory while no `<generate-embedding>` element is
 * attached.
 *
 * The lower half of the file is a generic request/response transport,
 * including support for unsolicited progress messages from the worker.
 * The upper half (exported helpers) is the domain API: lifecycle, status,
 * embedding, similarity, and progress subscription.
 */

/**
 * Lazily-created worker instance.
 *
 * The worker is built as a separate webpack entry and served at a stable
 * URL (/generate-embedding-worker.js), self-contained with no bare imports.
 *
 * @type {Worker|null}
 */
let worker = null;

/** @type {number} Number of active consumers holding the embedder */
let referenceCount = 0;

/** @type {number} Monotonic request id counter */
let nextRequestId = 1;

/** @type {Map<number, {resolve: Function, reject: Function, worker: Worker}>} In-flight requests */
const pendingRequests = new Map();

/** @type {Set<Function>} Progress subscriber callbacks */
const progressListeners = new Set();

/**
 * Default worker URL options applied to every acquire. Callers can
 * override per-acquire; see acquireEmbedder().
 *
 * @type {{workerUrl: string|null, modelPath: string, ortPath: string, backend: string|null}}
 */
const defaultOptions = {
  workerUrl: null,
  modelPath: '/models/',
  ortPath: '/ort/',
  backend: null,
};

/**
 * Reject in-flight requests and remove them from the pending map.
 *
 * @param {Error} error - The rejection reason
 * @param {Worker|null} [onlyWorker=null] - Restrict rejection to requests
 *   sent to this worker instance (requests belonging to a freshly re-acquired
 *   worker must survive an old worker's teardown)
 * @returns {void}
 */
function rejectPending(error, onlyWorker = null) {
  pendingRequests.forEach(({ reject, worker: requestWorker }, id) => {
    if (onlyWorker && requestWorker !== onlyWorker) {
      return;
    }
    pendingRequests.delete(id);
    reject(error);
  });
}

/**
 * Create the embedding worker and wire up its message handler.
 *
 * @param {{workerUrl: string|null, modelPath: string, ortPath: string, backend: string|null}} options
 * @returns {Worker} The new embedding worker instance
 */
function createWorker(options) {
  // The worker is built as a separate webpack entry and served at a
  // stable URL. Using an absolute path avoids webpack's native worker
  // handling, which emits module-worker auxiliary chunks that keep bare
  // npm imports and fail in the browser.
  const workerUrl = new URL(
    options.workerUrl ?? '/generate-embedding-worker.js',
    globalThis.location?.href ?? 'http://localhost',
  );

  // Local model / ORT paths are forwarded to the worker, which sets
  // env.localModelPath and env.backends.onnx.wasm.wasmPaths from them.
  if (options.modelPath) {
    workerUrl.searchParams.set('models', options.modelPath);
  }
  if (options.ortPath) {
    workerUrl.searchParams.set('ort', options.ortPath);
  }

  // Backend override: per-acquire option wins, otherwise fall back to the
  // page-level ?embedBackend=wasm|webgpu param (deterministic e2e testing).
  const pageParams = new URLSearchParams(globalThis.location?.search ?? '');
  const backend = options.backend ?? pageParams.get('embedBackend');
  if (backend === 'wasm' || backend === 'webgpu') {
    workerUrl.searchParams.set('backend', backend);
  }

  const instance = new Worker(workerUrl);

  instance.onmessage = (event) => {
    const data = event.data;

    // Unsolicited progress messages are routed to subscribers.
    if (data && data.type === 'progress') {
      progressListeners.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error('[embeddings] Progress listener threw:', error);
        }
      });
      return;
    }

    const { id, ok, result, error } = data;
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    if (ok) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error));
    }
  };

  instance.onerror = (event) => {
    // A catastrophic worker failure rejects every in-flight request.
    // ErrorEvents from worker load failures often have an empty message,
    // so log the whole event and fall back to any available detail.
    const message = event.message || event.error?.message || event.error || 'unknown worker error';
    console.error('[embeddings] Worker error:', message, event);
    rejectPending(new Error(`Embedding worker error: ${message}`), instance);
  };

  return instance;
}

/**
 * Send an action to the worker and await its response.
 *
 * @param {string} action - Action name (see src/embed-worker.js)
 * @param {object} [params={}] - Action parameters
 * @returns {Promise<any>} The action result
 */
function callWorker(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Embedding worker is not running; call acquireEmbedder() first'));
      return;
    }
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject, worker });
    worker.postMessage({ id, action, params });
  });
}

/**
 * Acquire the shared embedding worker, creating it on first use.
 *
 * Every `<generate-embedding>` element acquires the embedder when it
 * connects and releases it when it disconnects; the worker lives exactly
 * as long as at least one consumer holds it.
 *
 * @param {object} [options={}] - Worker creation options (first acquire wins)
 * @param {string} [options.workerUrl] - Override the worker script URL
 * @param {string} [options.modelPath] - Base URL for local model files (default '/models/')
 * @param {string} [options.ortPath] - Base URL for ORT wasm files (default '/ort/')
 * @param {string} [options.backend] - 'wasm' or 'webgpu' to force a backend
 * @returns {Worker} The embedding worker instance
 */
export function acquireEmbedder(options = {}) {
  referenceCount++;
  if (!worker) {
    worker = createWorker({ ...defaultOptions, ...options });
  }
  return worker;
}

/**
 * Release the shared embedding worker.
 *
 * When the last consumer releases, the worker is asked to dispose its
 * pipeline (freeing ONNX session memory) and is then terminated, which
 * guarantees the whole model runtime leaves memory. In-flight requests
 * belonging to the terminated worker are rejected; requests on a freshly
 * re-acquired worker are unaffected.
 *
 * @returns {Promise<void>} Resolves once teardown has been initiated
 */
export async function releaseEmbedder() {
  if (referenceCount > 0) {
    referenceCount--;
  }
  if (referenceCount > 0 || !worker) {
    return;
  }

  const dyingWorker = worker;
  worker = null;

  // Best-effort in-worker cleanup, then guaranteed teardown. The response
  // may never arrive if the worker is busy; terminate regardless.
  const disposeRequest = new Promise((resolve) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject: resolve, worker: dyingWorker }); // resolve either way
    dyingWorker.postMessage({ id, action: 'dispose', params: {} });
  });
  await Promise.race([
    disposeRequest,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  dyingWorker.terminate();
  // A consumer may already have re-acquired a fresh worker; reject only the
  // requests that were sent to the worker we just terminated.
  rejectPending(new Error('Embedding worker released: no consumers remain'), dyingWorker);
}

/**
 * Report how many embedding workers are currently running.
 *
 * Exposed primarily for tests asserting that removing the last
 * `<generate-embedding>` element really tears the worker down.
 *
 * @returns {number} 0 or 1
 */
export function getActiveWorkerCount() {
  return worker ? 1 : 0;
}

/**
 * Register a callback for model download progress events.
 *
 * @param {(progress: object) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onProgress(callback) {
  progressListeners.add(callback);
  return () => {
    progressListeners.delete(callback);
  };
}

/**
 * Report the active backend, dtype, model id, and readiness.
 *
 * @returns {Promise<{backend: string, dtype: string, model: string, ready: boolean, dims: number}>}
 */
export function getEmbedderStatus() {
  return callWorker('status');
}

/**
 * Embed one or more texts.
 *
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][]>} One normalized 384-dim vector per text
 */
export function embedTexts(texts) {
  return callWorker('embed', { texts });
}

/**
 * Compute cosine similarity between two normalized vectors.
 *
 * Because the embedding worker returns L2-normalized vectors, cosine
 * similarity reduces to a dot product.
 *
 * @param {number[]} a - First normalized vector
 * @param {number[]} b - Second normalized vector
 * @returns {number} Cosine similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new Error('cosineSimilarity expects two arrays');
  }
  if (a.length !== b.length) {
    throw new Error('cosineSimilarity expects arrays of equal length');
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
