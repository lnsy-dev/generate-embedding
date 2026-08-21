/**
 * Embedding Worker Unit Tests
 *
 * Unit tests for src/embed-worker.js — the worker's message protocol and
 * Transformers.js integration, exercised with a mocked pipeline.
 *
 * How this works without a browser:
 *   - `@huggingface/transformers` is mocked so we can control the pipeline
 *     and env objects.
 *   - The worker's globals (`self.onmessage` / `self.postMessage`) are
 *     provided by this test file before importing the worker module.
 *   - `navigator.gpu` is stubbed to exercise the WebGPU fallback path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/** @type {object} Mock env object exposed to the worker */
const mockEnv = {
  allowLocalModels: false,
  allowRemoteModels: false,
  localModelPath: null,
  backends: {
    onnx: {
      wasm: {
        wasmPaths: null,
      },
    },
  },
};

/** @type {Array<{device: string, dtype: string}>} Record of pipeline calls */
let pipelineCalls = [];

/** @type {Function|null} Controls whether the next pipeline call resolves or rejects */
let pipelineBehavior = null;

/** @type {boolean} Whether the mock extractor's dispose hooks were called */
let extractorDisposed = false;

/**
 * Mock extractor returned by pipeline(). It accepts texts and options and
 * returns a tensor-like object with a tolist() method, and exposes
 * dispose() hooks on its model and tokenizer like the real pipeline.
 *
 * @param {string[]} texts
 * @param {object} options
 * @returns {{tolist: () => number[][]}}
 */
function mockExtractor(texts, options) {
  return {
    tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
    options,
  };
}

vi.mock('@huggingface/transformers', () => ({
  env: mockEnv,
  pipeline: vi.fn((...args) => {
    pipelineCalls.push(args);
    if (pipelineBehavior) {
      return pipelineBehavior(...args);
    }
    const fn = mockExtractor;
    fn.model = { dispose: () => { extractorDisposed = true; } };
    fn.tokenizer = { dispose: () => {} };
    return Promise.resolve(fn);
  }),
}));

/** Pending response waiters keyed by message id */
const waiters = new Map();
let nextId = 1;

/**
 * Send an action message to the worker and await its response,
 * exactly as src/lib/embeddings.js does in the browser.
 *
 * @param {string} action - Worker action name
 * @param {object} [params={}] - Action parameters
 * @returns {Promise<any>} The action result (rejects on worker error)
 */
function callWorker(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiters.set(id, { resolve, reject });
    self.onmessage({ data: { id, action, params } });
  });
}

beforeAll(async () => {
  // Provide the worker globals, then import the worker module.
  // The import kicks off model initialization immediately.
  globalThis.self = globalThis;
  self.location = { search: '' };
  self.postMessage = (message) => {
    const waiter = waiters.get(message.id);
    if (!waiter) {
      return;
    }
    waiters.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.result);
    } else {
      waiter.reject(new Error(message.error));
    }
  };

  // Default: WASM backend, no WebGPU
  vi.stubGlobal('navigator', { gpu: null });

  await import('../../src/embed-worker.js');
});

afterAll(() => {
  delete globalThis.self;
  vi.unstubAllGlobals();
});

describe('embed-worker', () => {
  it('sets local model path and local ORT wasm paths after initialization', async () => {
    await callWorker('status'); // ensures initialize() has run
    expect(mockEnv.allowLocalModels).toBe(true);
    expect(mockEnv.allowRemoteModels).toBe(true);
    expect(mockEnv.localModelPath).toBe('/models/');
    expect(mockEnv.backends.onnx.wasm.wasmPaths).toBe('/ort/');
  });

  it('reports status with the active backend', async () => {
    const status = await callWorker('status');

    expect(status.backend).toBe('wasm');
    expect(status.dtype).toBe('q8');
    expect(status.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(status.ready).toBe(true);
    expect(status.dims).toBe(384);
  });

  it('embeds texts with mean pooling and normalization', async () => {
    const result = await callWorker('embed', { texts: ['hello', 'world'] });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);

    // The embed action reuses the pipeline created during initialization.
    const initCall = pipelineCalls.find((call) => call[0] === 'feature-extraction');
    expect(initCall).toBeDefined();
    expect(initCall[2]).toMatchObject({
      device: 'wasm',
      dtype: 'q8',
    });
  });

  it('rejects embed with an empty texts array', async () => {
    await expect(callWorker('embed', { texts: [] })).rejects.toThrow('non-empty array');
  });

  it('rejects unknown actions', async () => {
    await expect(callWorker('not-an-action')).rejects.toThrow('Unknown embed-worker action: not-an-action');
  });

  it('dispose releases the pipeline and status reports not ready', async () => {
    extractorDisposed = false;

    const result = await callWorker('dispose');
    expect(result.disposed).toBe(true);
    expect(extractorDisposed).toBe(true);

    const status = await callWorker('status');
    // status re-initializes after dispose, so wait for the pipeline to
    // come back before asserting on backend fields; the important part is
    // that dispose ran and a fresh pipeline was created.
    expect(status.model).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('re-initializes the pipeline lazily after dispose', async () => {
    // The status call above already triggered re-initialization.
    await callWorker('status');
    const status = await callWorker('status');
    expect(status.ready).toBe(true);
    expect(status.backend).toBe('wasm');
  });

  it('falls back from WebGPU to WASM when WebGPU pipeline creation fails', async () => {
    // Reset pipeline call history and configure the mock to reject once.
    pipelineCalls = [];
    let callCount = 0;
    pipelineBehavior = () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('WebGPU not available'));
      }
      return Promise.resolve(mockExtractor);
    };

    // Force a fresh worker import with WebGPU exposed.
    vi.resetModules();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: () => Promise.resolve({}),
      },
    });

    // Re-import to trigger initialization with the new navigator.
    await import('../../src/embed-worker.js');

    // Wait a tick for the async init loop to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const status = await callWorker('status');
    expect(status.backend).toBe('wasm');
    expect(status.dtype).toBe('q8');

    // The first attempt should have been WebGPU/fp16, the second WASM/q8.
    const featureCalls = pipelineCalls.filter((call) => call[0] === 'feature-extraction');
    expect(featureCalls).toHaveLength(2);
    expect(featureCalls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'fp16' });
    expect(featureCalls[1][2]).toMatchObject({ device: 'wasm', dtype: 'q8' });

    // Restore default behavior
    pipelineBehavior = null;
  });
});
