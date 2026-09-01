# generate-embedding tutorial

> Turn any text on a web page into a 384-dimensional sentence embedding — locally, in the browser, with no API key.

`<generate-embedding>` is a vanilla-JS custom element that watches its own text, sends it to a dedicated web worker, and emits a sentence embedding using the lightweight [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model (via [Transformers.js](https://huggingface.co/docs/transformers.js)). It prefers WebGPU when available and falls back to WASM, so everything stays on the client.

---

## Install from npm

```bash
npm install generate-embedding
```

`npm install` runs a postinstall script that downloads the model weights (~68 MB) and ONNX Runtime wasm binaries into `node_modules/generate-embedding/models/` and `node_modules/generate-embedding/ort/`. Set `GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1` to skip the download — the component will fetch the model from the Hugging Face hub on first use instead.

Import the package once in your app to register the custom element and inject its styles:

```javascript
import 'generate-embedding';
```

Then use the element in HTML:

```html
<generate-embedding contenteditable="true">
  The quick brown fox jumps over the lazy dog.
</generate-embedding>
```

### Serving the worker, models, and ORT files

The component loads three things over HTTP at runtime:

1. `/generate-embedding-worker.js` — the embedding web worker.
2. `/models/` — the locally downloaded model weights.
3. `/ort/` — the ONNX Runtime wasm binaries.

You must copy these from `node_modules/generate-embedding/` into your public / static folder so they are served at those paths:

```bash
# Example: copy into a Vite / webpack public directory
cp node_modules/generate-embedding/dist/generate-embedding-worker.js public/
cp node_modules/generate-embedding/dist/*.mjs public/
cp node_modules/generate-embedding/dist/*.wasm public/
cp -r node_modules/generate-embedding/models public/
cp -r node_modules/generate-embedding/ort public/
```

If you serve the package from a sub-path or a CDN, override the URLs with attributes:

```html
<generate-embedding
  worker-url="/assets/generate-embedding-worker.js"
  model-path="/assets/models/"
  ort-path="/assets/ort/"
  contenteditable="true"
>
  Edit me.
</generate-embedding>
```

If the worker or model files are not served, the component still works: Transformers.js falls back to fetching the model from the Hugging Face hub and the worker falls back to CDN-hosted ONNX Runtime binaries. The offline / self-hosted guarantee only applies when the files are served locally.

### Programmatic API

After importing the package, the embeddings client is available on `window.embeddings` for debugging and advanced use:

```javascript
import 'generate-embedding';

const { embedTexts, cosineSimilarity, getEmbedderStatus } = window.embeddings;

const vectors = await embedTexts(['hello world', 'goodbye world']);
console.log(cosineSimilarity(vectors[0], vectors[1]));
```

You can also import the client module directly if your bundler handles the bare imports:

```javascript
import { embedTexts, cosineSimilarity } from 'generate-embedding/lib';
```

In this tutorial you will:

1. Get the project running locally.
2. Embed editable text with `<generate-embedding>`.
3. Compare two sentences with cosine similarity.
4. Build a tiny semantic search engine.
5. Persist embeddings in markup.
6. Build and deploy a production bundle.

---

## Prerequisites

- Node.js 18 or later
- A Chromium-based browser for tests (Playwright); runtime works in any modern browser
- About 100 MB of disk space for model weights and ONNX Runtime binaries

## Quick start (clone and hack)

To run the source repo locally:

```bash
git clone https://github.com/lnsy-dev/generate-embedding.git
cd generate-embedding
npm install          # downloads model weights (~68 MB) and ORT wasm binaries
npm start            # opens the dev server on http://localhost:3000
```

The first `npm install` runs a postinstall script. If you want to skip the local download, set `GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1`; the component will fetch the model from the Hugging Face hub the first time it runs instead.

### Bundler examples

**webpack**

Copy the worker, wasm, model, and ORT assets to your output directory with `CopyWebpackPlugin`:

```javascript
new CopyWebpackPlugin({
  patterns: [
    { from: 'node_modules/generate-embedding/dist/generate-embedding-worker.js', to: 'generate-embedding-worker.js' },
    { from: 'node_modules/generate-embedding/dist/*.mjs', to: '[name][ext]' },
    { from: 'node_modules/generate-embedding/dist/*.wasm', to: '[name][ext]' },
    { from: 'node_modules/generate-embedding/models', to: 'models' },
    { from: 'node_modules/generate-embedding/ort', to: 'ort' },
  ],
});
```

**Vite**

Use `vite-plugin-static-copy` or a post-build script to copy the same files into `public/` or `dist/`.

**Static / no bundler**

If you are writing plain HTML, copy the assets manually and import the bundle from a CDN or relative path:

```html
<script type="module">
  import 'https://unpkg.com/generate-embedding';
</script>
```

> Note: CDN usage still requires the worker, models, and ORT files to be served. The easiest path for static sites is to copy the files from `node_modules/generate-embedding/` into your site root as shown above.

---

## Step 1 — Embed editable text

Open `index.html` (it is also the webpack dev-server template). Drop a `<generate-embedding>` element anywhere in the body and make it `contenteditable`:

```html
<generate-embedding id="demo" contenteditable="true">
  The quick brown fox jumps over the lazy dog.
</generate-embedding>
```

The component watches `innerText`. Whenever you stop typing for 300 ms, it sends the text to the worker and publishes the result in two ways:

- The element's `vector` attribute, which contains a JSON string of the 384 numbers.
- A `EMBEDDING-RESULT` event with the full result object.

Listen to the event in plain JavaScript:

```javascript
const demo = document.getElementById('demo');

demo.addEventListener('EMBEDDING-RESULT', (event) => {
  console.log('text:', event.detail.text);
  console.log('vector:', event.detail.vector);      // number[384]
  console.log('duration:', event.detail.duration);  // milliseconds
});
```

If you are using the dataroom-js helpers bundled with this project, you can also use `on`:

```javascript
demo.on('EMBEDDING-RESULT', (data) => {
  const preview = data.vector.slice(0, 5).map(n => n.toFixed(4)).join(', ');
  console.log(`Embedding: [${preview} …]`);
});
```

Refresh the page, click the sentence, and edit it. The browser console will show a new vector every time you pause typing.

### Live demo on GitHub Pages

A self-contained, interactive demo lives in `docs/` and is served on GitHub
Pages: editable embedding, live cosine similarity, semantic search, and model
download progress — all as static files. Rebuild it after changes with:

```bash
npm run build:docs   # webpack --config webpack.docs.config.js → docs/
```

The build emits four committed artifacts — `docs/main.min.js`,
`docs/generate-embedding-worker.js`, and copies of `models/` and `ort/`
(minus the experimental JSPI ORT variant) — so the demo is **fully
self-hosted**: every request stays same-origin, nothing is fetched from a
CDN or the Hugging Face hub at runtime, and CORS can never interfere. All
assets are loaded with relative URLs so they work from a project sub-path
like `example.com/repo/`.

Note the repo-root ignore rules are anchored (`/models/`, `/ort/`) so the
committed `docs/models/` and `docs/ort/` copies are tracked. The demo is
covered by `tests/e2e/docs-demo.spec.js`, which serves `docs/` from a
sub-path, aborts every cross-origin request, and exercises all three
widgets.

---

## Step 2 — Compare sentences with cosine similarity

Embeddings turn sentences into points in space. Two points that point in the same direction are semantically similar. The cosine similarity between two vectors is a number from -1 to 1; for normalized sentence embeddings it is effectively 0 (unrelated) to 1 (very similar).

Add two elements to your page:

```html
<generate-embedding id="a" contenteditable="true">A cat naps in the sun.</generate-embedding>
<generate-embedding id="b" contenteditable="true">A kitten sleeps in the sunshine.</generate-embedding>
<p id="similarity">Similarity: —</p>
```

Then compute similarity whenever either element emits a result:

```javascript
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let vectorA = null;
let vectorB = null;

function updateSimilarity() {
  if (!vectorA || !vectorB) return;
  const score = cosineSimilarity(vectorA, vectorB);
  document.getElementById('similarity').textContent =
    `Similarity: ${score.toFixed(3)}`;
}

document.getElementById('a').addEventListener('EMBEDDING-RESULT', (e) => {
  vectorA = e.detail.vector;
  updateSimilarity();
});

document.getElementById('b').addEventListener('EMBEDDING-RESULT', (e) => {
  vectorB = e.detail.vector;
  updateSimilarity();
});
```

Try changing sentence B to `The stock market closed lower today.` The similarity score will drop sharply.

---

## Step 3 — Build a tiny semantic search engine

Because every embedding lives in the same 384-dimensional space, you can find the sentence closest to a query by comparing vectors.

Create a small corpus:

```html
<ul id="corpus">
  <li><generate-embedding>A cat naps in the sun.</generate-embedding></li>
  <li><generate-embedding>The stock market closed lower today.</generate-embedding></li>
  <li><generate-embedding>How do I bake sourdough bread?</generate-embedding></li>
</ul>

<input id="query" type="text" value="kitten sleeping" />
<ol id="results"></ol>
```

Then rank the corpus against the query vector:

```javascript
const queryEl = document.getElementById('query');
const corpusEls = [...document.querySelectorAll('#corpus generate-embedding')];
const resultsEl = document.getElementById('results');

async function search() {
  const queryText = queryEl.value.trim();
  if (!queryText) return;

  // Create a temporary element to embed the query.
  const temp = document.createElement('generate-embedding');
  temp.textContent = queryText;
  document.body.appendChild(temp);

  const queryVector = await new Promise((resolve) => {
    temp.addEventListener('EMBEDDING-RESULT', (e) => resolve(e.detail.vector), { once: true });
  });

  const scored = corpusEls
    .map((el) => {
      const vector = el.hasAttribute('vector')
        ? JSON.parse(el.getAttribute('vector'))
        : null;
      return {
        text: el.innerText,
        score: vector ? cosineSimilarity(queryVector, vector) : -1,
      };
    })
    .sort((a, b) => b.score - a.score);

  resultsEl.innerHTML = scored
    .map((item) => `<li>${item.text} — <strong>${item.score.toFixed(3)}</strong></li>`)
    .join('');

  temp.remove();
}

queryEl.addEventListener('change', search);
```

When you run the search, the `A cat naps in the sun.` item should rank highest because it is semantically closest to `kitten sleeping`.

---

## Step 4 — Persist embeddings in markup

Every successful embed writes two attributes to the element:

- `generated` — a marker that the vector matches the current text.
- `vector` — the JSON embedding.

If you save that markup and reload it, the component detects the persisted vector and re-emits it immediately with `cached: true`, without starting the worker. This is useful for server-rendered pages, static sites, or documents saved to disk.

Example persisted markup:

```html
<generate-embedding generated vector="[0.0123,0.0456,...]">
  A cat naps in the sun.
</generate-embedding>
```

The vector must be a valid 384-dim array and the text must be non-empty. As soon as the user edits the text, the `generated` marker is removed and a fresh embedding is computed.

---

## Step 5 — Configure the worker and backend

By default the component loads `/generate-embedding-worker.js`, `/models/`, and `/ort/` from the same origin. You can override these with attributes:

```html
<generate-embedding
  worker-url="/my-worker.js"
  model-path="/assets/models/"
  ort-path="/assets/ort/"
  backend="wasm"
  debounce="500"
  contenteditable="true"
>
  Edit me.
</generate-embedding>
```

| Attribute | Default | Purpose |
|-----------|---------|---------|
| `worker-url` | `/generate-embedding-worker.js` | Override the worker script URL. |
| `model-path` | `/models/` | Base URL for locally served model files. |
| `ort-path` | `/ort/` | Base URL for ONNX Runtime wasm files. |
| `backend` | auto | `wasm` or `webgpu` to force a backend. |
| `debounce` | `300` | Debounce interval in ms for text changes. |

Use `backend="wasm"` when testing in headless environments or when WebGPU is unreliable. The Playwright tests force WASM with `?embedBackend=wasm`.

---

## Step 6 — Run the tests

The project has two test suites.

Fast unit tests (worker protocol, lifecycle, refcounting) with Vitest:

```bash
npm run test:unit
```

End-to-end tests with Playwright, including memory profiling:

```bash
npx playwright install chromium   # first time only
npm test
```

Run tests against the production build:

```bash
npm run test:prod
```

---

## Step 7 — Build for production

```bash
npm run build
```

This produces `dist/` with:

- `main.min.js` — the bundled app (custom element + CSS).
- `generate-embedding-worker.js` — the embedding worker.
- `chunks/` — any dynamic chunks.
- `models/` and `ort/` — copied from `models/` and `ort/` if they were downloaded.

Serve `dist/` from any static host. Make sure `models/` and `ort/` are served at the paths configured by `model-path` and `ort-path`. If they are missing, the component falls back to the Hugging Face hub.

---

## Events reference

| Event | Detail | When |
|-------|--------|------|
| `EMBEDDING-STATUS` | `{ backend, dtype, model, ready, dims }` | Model pipeline is ready. |
| `EMBEDDING-PROGRESS` | Transformers.js progress payload | Model download / load progress. |
| `EMBEDDING-RESULT` | `{ text, vector, duration, cached }` | New or restored embedding. |
| `EMBEDDING-ERROR` | `{ error }` | Initialization or inference failed. |

---

## How it works

- `src/generate-embedding.js` defines the custom element and observes `innerText`.
- `src/lib/embeddings.js` manages a shared, reference-counted worker.
- `src/embed-worker.js` runs the model in a web worker so the UI thread never blocks.
- `scripts/download-model.js` downloads model weights and ORT binaries at install time.
- Webpack bundles the main app and the worker as separate entries.

When the last `<generate-embedding>` element is removed from the DOM, the worker is terminated and the model runtime is freed from memory.

---

## Next steps

- Store embeddings in IndexedDB or on a server to avoid recomputation.
- Build a recommendation UI by clustering similar sentences.
- Combine with vector search libraries such as `usearch` or `hnswlib` for larger corpora.

---

## License

Unlicense — see `package.json`.
