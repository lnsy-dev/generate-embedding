# Agent Conventions for Pochade-JS Projects

This file governs all code in this directory and its subdirectories.

## Technology Stack

- **JavaScript**: Vanilla ES2020+ (no frameworks)
- **CSS**: Standard CSS with variables (no CSS-in-JS, no Shadow DOM)
- **Build Tool**: Webpack 5 with SWC transpilation
- **Custom Elements**: dataroom-js (extends HTMLElement)
- **Embeddings**: `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` (ONNX Runtime Web, WebGPU → WASM fallback), running in a dedicated web worker
- **Workers**: Web Workers with custom inline bundling and separate-entry bundling for the embedding worker
- **Testing**: Playwright (e2e, incl. memory profiling) and Vitest (unit)

## Code Style

### Comments

Use **DocBlock style comments** for all classes, methods, and exported functions:

```javascript
/**
 * Brief description.
 *
 * @param {string} paramName Description
 * @returns {number} Description
 */
```

Use inline `//` comments for implementation logic.

### Custom Elements

```javascript
import DataroomElement from 'dataroom-js';

class MyComponent extends DataroomElement {
  async initialize() {
    // Component setup
  }
}

if (!customElements.get('my-component')) {
  customElements.define('my-component', MyComponent);
}
```

Rules:
- Element names MUST contain a hyphen
- NEVER use Shadow DOM
- NEVER embed CSS in JavaScript
- Create CSS in `styles/<component-name>.css` and import in `index.css`
- Components holding external resources (workers, observers, subscriptions) MUST override `disconnect()` and release them there — dataroom-js calls it from `disconnectedCallback`. Also disconnect the base class's `this.attributeObserver` if set

### Embeddings

- `<generate-embedding>` (`src/generate-embedding.js`) embeds its own innerText into a 384-dim vector, published as the `vector` attribute (JSON) and the `EMBEDDING-RESULT` event
- ALL model access goes through `src/lib/embeddings.js` (`acquireEmbedder`/`releaseEmbedder` refcounting) — components never message the worker directly
- The worker is shared: it is created on first `acquireEmbedder()` and terminated when the last consumer releases, freeing the ONNX runtime from memory
- Inference lives ONLY in `src/embed-worker.js` (`{ id, action, params }` → `{ id, ok, result|error }`); actions: `status`, `embed`, `dispose`
- Model files are downloaded at install time by `scripts/download-model.js` into `models/` (skip with `GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1`); ORT wasm binaries live in `ort/`. Both must be served at `/models/` and `/ort/` — webpack handles this in dev (`devServer.static`) and prod (`CopyWebpackPlugin`). If unserved, Transformers.js falls back to the Hugging Face hub + Cache Storage

### Web Workers

Always use this exact syntax:

```javascript
const worker = new Worker(new URL('./my-worker.js', import.meta.url));
```

Never use string paths: `new Worker('./my-worker.js')` — bundlers cannot trace them.

For workers that import npm modules (the embedding worker), use the separate-entry
strategy instead: build the worker as its own webpack entry with
`chunkLoading: 'import-scripts'` and load it at a stable URL. This avoids bare npm
imports in auxiliary chunks and keeps dynamic-import chunks loadable inside a
`DedicatedWorkerGlobalScope`:

```javascript
// webpack.config.js
entry: {
  'my-worker': {
    import: './src/my-worker.js',
    chunkLoading: 'import-scripts',
    wasmLoading: 'fetch',
  },
}

// renderer code
const worker = new Worker('/my-worker.js');
```

When using the separate-entry strategy, always set `chunkLoading: 'import-scripts'` so
webpack loads chunks with `importScripts()` instead of `document.createElement('script')`,
which is undefined in workers. The dev-server client MUST stay disabled (`client: false`)
— it overrides the Worker constructor and would run the worker on the main thread.

### Testing

**Directive:** Write and run tests for every feature you add or change. Keep both suites green, and add a matching test whenever you introduce new behavior.

#### E2E Tests (Playwright)

- Use `@playwright/test`; place tests in `tests/e2e/*.spec.js`
- Run with `npm test`; debug with `npm run test:ui`; first run needs `npx playwright install chromium`
- Use `page.locator()` for element selection and `page.evaluate()` for testing custom events
- Use 15–30-second timeouts for wasm/model-dependent assertions
- Force the WASM backend with the `?embedBackend=wasm` page param — headless WebGPU is unreliable
- Memory profiling (`tests/e2e/memory.spec.js`) uses `--enable-precise-memory-info` + `--js-flags=--expose-gc` (configured in `playwright.config.js`); assert `window.embeddings.getActiveWorkerCount()` returns to 0 and the heap returns to baseline

#### Unit Tests (Vitest)

- Use `vitest`; place tests in `tests/unit/*.test.js`; run with `npm run test:unit`
- Unit tests run in Node with explicit mocks — no dev server, no DOM emulation layer
- `src/lib/embeddings.js` is tested against a fake `Worker` global that captures messages (assert exact action names and params, refcounting, termination)
- `src/embed-worker.js` is tested by providing `self.onmessage`/`self.postMessage` globals and mocking `@huggingface/transformers`
- New logic MUST ship with unit tests in the same change

### State Management

- Use component instance properties (`this.propertyName`)
- Emit custom events for cross-component communication via `this.event('name', detail)`
- Listen to events via `this.on('name', callback)` or `this.once('name', callback)`

### HTTP Requests

- Use `this.getJSON(url)` for simple GET requests to JSON endpoints
- Use `this.call(endpoint, body)` for POST requests with auth/timeout support
- Always wrap in `try/catch` for error handling

## File Organization

| Directory | Purpose |
|-----------|---------|
| `src/` | JavaScript modules and components |
| `src/generate-embedding.js` | The `<generate-embedding>` custom element |
| `src/lib/embeddings.js` | Main-thread embeddings client (worker lifecycle, refcounting) |
| `src/embed-worker.js` | The embeddings web worker (all-MiniLM-L6-v2 via Transformers.js) |
| `models/` | Downloaded model weights (postinstall artifact, git-ignored) |
| `ort/` | ONNX Runtime Web binaries (postinstall artifact, git-ignored) |
| `styles/` | CSS files (one per component or concern) |
| `tests/` | `tests/e2e/` Playwright specs, `tests/unit/` Vitest tests |
| `scripts/` | Build-time transformation scripts + `download-model.js` (postinstall) |
| `assets/` | Static files (images, fonts, etc.) |

## Prohibited Patterns

- ❌ TypeScript
- ❌ React/Vue/Angular/Svelte
- ❌ Shadow DOM
- ❌ CSS-in-JS (styled-components, emotion, etc.)
- ❌ Inline styles in JavaScript
- ❌ Framework-specific state managers (Redux, Pinia, etc.)
- ❌ jQuery or similar DOM wrappers
- ❌ `new Worker('./relative-path.js')` (use `new URL(..., import.meta.url)`)
