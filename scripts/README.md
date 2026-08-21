# Build Scripts

This directory contains build-time scripts for the generate-embedding package.

## download-model.js

Run automatically as the `postinstall` npm hook. Downloads the
`Xenova/all-MiniLM-L6-v2` model files into `models/` and copies the ONNX Runtime Web
binaries from `node_modules/onnxruntime-web/dist` into `ort/`.

Set `GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1` to skip the download (for example in CI
or offline installs). The component will then fall back to downloading the model from the
Hugging Face hub into the browser's Cache Storage at runtime.

## transform-workers.js

A webpack loader that inlines Web Worker imports for projects that need a single-file
deployment. It detects the pattern:

```javascript
const worker = new Worker(new URL('./my-worker.js', import.meta.url));
```

and replaces it with an inline Blob-based worker.

The embedding worker (`src/embed-worker.js`) is **not** processed by this loader. It is
built as a separate webpack entry (`generate-embedding-worker`) because it imports the
ESM-only `@huggingface/transformers` package and must run in a real
`DedicatedWorkerGlobalScope`.
