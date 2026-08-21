/**
 * Generate Embedding Component
 *
 * `<generate-embedding>` watches its own innerText and emits a 384-dim
 * L2-normalized sentence embedding (all-MiniLM-L6-v2) whenever the text
 * changes. The embedding is published two ways:
 *   - the `vector` attribute (JSON string of the 384-dim array)
 *   - the `EMBEDDING-RESULT` event ({ text, vector, duration })
 *
 * Persistence: after every successful embed the element carries a
 * `generated` marker attribute alongside `vector`. If an element is
 * created (e.g. on page reload) with BOTH `generated` and a valid
 * `vector` attribute, the embedding is restored instead of regenerated —
 * and the worker is not even started until the text actually changes.
 * The restored embedding is re-published as EMBEDDING-RESULT with
 * `cached: true`.
 *
 * All inference runs in a shared web worker (src/embed-worker.js via
 * src/lib/embeddings.js) so the UI thread never blocks. The worker is
 * reference-counted: when the last `<generate-embedding>` element is
 * removed from the DOM, the worker's pipeline is disposed and the worker
 * is terminated, taking the model runtime out of memory.
 *
 * Attributes:
 *   worker-url  Override the worker script URL (default '/generate-embedding-worker.js')
 *   model-path  Base URL for local model files (default '/models/')
 *   ort-path    Base URL for ONNX Runtime wasm files (default '/ort/')
 *   backend     'wasm' or 'webgpu' to force a backend
 *   debounce    Debounce interval in ms for text changes (default 300)
 *   generated   Marker: `vector` was generated for the current innerText
 *   vector      JSON string of the 384-dim embedding (output)
 *
 * Events emitted (dataroom-js this.event):
 *   EMBEDDING-STATUS    { backend, dtype, model, ready, dims }
 *   EMBEDDING-PROGRESS  { status, progress, ... } (model download progress)
 *   EMBEDDING-RESULT    { text, vector, duration, cached }
 *   EMBEDDING-ERROR     { error }
 */

import DataroomElement from 'dataroom-js';
import {
  acquireEmbedder,
  releaseEmbedder,
  getEmbedderStatus,
  embedTexts,
  onProgress,
} from './lib/embeddings.js';

/** Default debounce interval (ms) for innerText changes. */
const DEFAULT_DEBOUNCE_MS = 300;

/** Expected embedding dimensions (all-MiniLM-L6-v2). */
const EMBEDDING_DIMS = 384;

/**
 * GenerateEmbedding
 *
 * A custom HTML element that continuously embeds its own text content
 * into a 384-dimensional vector.
 *
 * @extends DataroomElement
 */
class GenerateEmbedding extends DataroomElement {
  /**
   * Initialize the component.
   *
   * Starts observing innerText. If the element already carries a valid
   * persisted embedding (`generated` + `vector` attributes, e.g. after a
   * page reload), the persisted vector is restored and re-published with
   * `cached: true` and the worker is NOT started. Otherwise the shared
   * embedding worker is acquired and the initial text is embedded.
   *
   * @async
   * @returns {Promise<void>}
   */
  async initialize() {
    /** @type {string|null} The last text that was (or is being) embedded */
    this.lastEmbeddedText = null;

    /** @type {number|null} Pending debounce timer id */
    this.embedTimer = null;

    /** @type {boolean} Whether this element holds a worker reference */
    this.embedderAcquired = false;

    const debounceAttr = parseInt(this.getAttribute('debounce'), 10);
    /** @type {number} Debounce interval for text changes */
    this.debounceMs = Number.isFinite(debounceAttr) ? debounceAttr : DEFAULT_DEBOUNCE_MS;

    // Forward model download progress as component events. Progress
    // listeners are module-level, so subscribing before the worker exists
    // is safe.
    this.unsubscribeProgress = onProgress((progress) => {
      this.event('EMBEDDING-PROGRESS', progress);
    });

    // Watch innerText: childList + characterData cover both wholesale
    // replacement (el.innerText = '...') and in-place text node edits.
    this.textObserver = new MutationObserver(() => this.scheduleEmbed());
    this.textObserver.observe(this, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    if (!this.restorePersistedEmbedding()) {
      this.ensureEmbedder();
    }

    // Embed whatever text the element was created with. When a persisted
    // embedding was restored this is a no-op (text is unchanged), so the
    // worker stays off until the text actually changes.
    this.scheduleEmbed(0);
  }

  /**
   * Acquire the shared embedding worker (idempotently) and report its
   * status once the model pipeline is ready.
   *
   * @returns {void}
   */
  ensureEmbedder() {
    if (this.embedderAcquired) {
      return;
    }

    // Acquire the shared worker; first element wins on options.
    acquireEmbedder({
      workerUrl: this.getAttribute('worker-url'),
      modelPath: this.getAttribute('model-path') ?? '/models/',
      ortPath: this.getAttribute('ort-path') ?? '/ort/',
      backend: this.getAttribute('backend'),
    });
    this.embedderAcquired = true;

    getEmbedderStatus()
      .then((status) => {
        if (this.isConnected) {
          this.event('EMBEDDING-STATUS', status);
        }
      })
      .catch((error) => {
        if (!this.isConnected) {
          return;
        }
        console.error('Embedding initialization failed:', error);
        this.event('EMBEDDING-ERROR', { error: error.message });
      });
  }

  /**
   * Restore a previously generated embedding from the element's own
   * attributes.
   *
   * Requires the `generated` marker plus a `vector` attribute holding a
   * valid 384-dim vector, and non-empty text. On success the persisted
   * vector is re-published as EMBEDDING-RESULT with `cached: true` and
   * the current text is recorded so it is not re-embedded.
   *
   * @returns {boolean} True when a persisted embedding was restored
   */
  restorePersistedEmbedding() {
    if (!this.hasAttribute('generated')) {
      return false;
    }

    const text = (this.innerText ?? '').trim();
    if (!text) {
      return false;
    }

    let vector = null;
    try {
      vector = JSON.parse(this.getAttribute('vector'));
    } catch {
      vector = null;
    }
    const isValid = Array.isArray(vector)
      && vector.length === EMBEDDING_DIMS
      && vector.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!isValid) {
      return false;
    }

    this.lastEmbeddedText = text;
    this.event('EMBEDDING-RESULT', { text, vector, duration: 0, cached: true });
    return true;
  }

  /**
   * Schedule an embedding pass, debounced so rapid text mutations
   * (typing, streaming updates) collapse into one inference call.
   *
   * @param {number} [delay] - Override delay in ms (defaults to debounceMs)
   * @returns {void}
   */
  scheduleEmbed(delay) {
    if (this.embedTimer !== null) {
      clearTimeout(this.embedTimer);
    }
    this.embedTimer = setTimeout(() => {
      this.embedTimer = null;
      this.embedCurrentText();
    }, delay ?? this.debounceMs);
  }

  /**
   * Embed the current innerText, skipping empty and unchanged text.
   *
   * @async
   * @returns {Promise<void>}
   */
  async embedCurrentText() {
    if (!this.isConnected) {
      return;
    }

    const text = (this.innerText ?? '').trim();
    if (!text || text === this.lastEmbeddedText) {
      return;
    }
    this.lastEmbeddedText = text;

    // The persisted embedding (if any) no longer matches the text.
    this.removeAttribute('generated');

    // Lazily start the worker: an element whose embedding was restored
    // from attributes only spins up the model when its text changes.
    this.ensureEmbedder();

    const start = performance.now();
    try {
      const vectors = await embedTexts([text]);
      // The element may have been removed while inference was running;
      // do not resurrect state on a detached element.
      if (!this.isConnected) {
        return;
      }
      const duration = Math.round(performance.now() - start);
      const vector = vectors[0];

      this.setAttribute('vector', JSON.stringify(vector));
      this.setAttribute('generated', '');
      this.event('EMBEDDING-RESULT', { text, vector, duration, cached: false });
    } catch (error) {
      if (!this.isConnected) {
        return;
      }
      console.error('Embedding failed:', error);
      this.event('EMBEDDING-ERROR', { error: error.message });
    }
  }

  /**
   * Graceful teardown, called by dataroom-js when the element is removed
   * from the DOM.
   *
   * Stops all observation, releases the shared worker (terminating it
   * when the last `<generate-embedding>` element is gone), and clears
   * element state so nothing keeps the model runtime reachable.
   *
   * @async
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.embedTimer !== null) {
      clearTimeout(this.embedTimer);
      this.embedTimer = null;
    }

    if (this.textObserver) {
      this.textObserver.disconnect();
      this.textObserver = null;
    }

    // The base class's attribute observer is never torn down by
    // dataroom-js; disconnect it here so nothing observes a detached
    // element.
    if (this.attributeObserver) {
      this.attributeObserver.disconnect();
      this.attributeObserver = null;
    }

    if (this.unsubscribeProgress) {
      this.unsubscribeProgress();
      this.unsubscribeProgress = null;
    }

    this.lastEmbeddedText = null;

    if (this.embedderAcquired) {
      this.embedderAcquired = false;
      await releaseEmbedder();
    }
  }
}

// Register the custom element
if (!customElements.get('generate-embedding')) {
  customElements.define('generate-embedding', GenerateEmbedding);
}
