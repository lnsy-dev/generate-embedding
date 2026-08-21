/**
 * Embeddings Client Unit Tests
 *
 * Unit tests for src/lib/embeddings.js — the main-thread client that
 * relays embedding actions to the embed worker and owns its lifecycle.
 *
 * The Worker global is replaced with a fake that captures outgoing
 * messages and answers them with scripted responses. These tests pin
 * down:
 *   - the exact action names and params each helper sends
 *   - request/response correlation by message id
 *   - progress message routing without resolving pending requests
 *   - error propagation (worker error responses and catastrophic failure)
 *   - acquire/release reference counting and worker termination
 *   - cosineSimilarity math
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Fake Worker stand-in. Each instance records every postMessage it
 * receives and replies asynchronously through the handler assigned to
 * FakeWorker.onMessage (default: a generic `ok: true, result: null`).
 */
class FakeWorker {
  static instances = [];
  static onMessage = null;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  static get latest() {
    return FakeWorker.instances[FakeWorker.instances.length - 1] ?? null;
  }

  postMessage(message) {
    this.messages.push(message);
    const handler = FakeWorker.onMessage || ((m) => ({ id: m.id, ok: true, result: null }));
    const response = handler(message, this);
    if (response) {
      queueMicrotask(() => this.onmessage?.({ data: response }));
    }
  }

  terminate() {
    this.terminated = true;
  }
}

/** @returns {Promise<object>} The freshly imported embeddings module */
async function importEmbeddingsModule() {
  return await import('../../src/lib/embeddings.js');
}

describe('embeddings client', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeWorker.instances = [];
    FakeWorker.onMessage = null;
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a worker pointing to the stable worker entry on first acquire', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await embeddings.getEmbedderStatus();

    expect(FakeWorker.latest).not.toBeNull();
    expect(FakeWorker.latest.url.pathname).toBe('/generate-embedding-worker.js');
  });

  it('reuses the same worker across calls', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await embeddings.getEmbedderStatus();
    await embeddings.embedTexts(['hello']);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.latest.messages).toHaveLength(2);
  });

  it('rejects calls made without an acquired worker', async () => {
    const embeddings = await importEmbeddingsModule();
    await expect(embeddings.embedTexts(['x'])).rejects.toThrow('acquireEmbedder');
  });

  it('getEmbedderStatus sends the status action and resolves its result', async () => {
    const status = { backend: 'wasm', dtype: 'q8', model: 'Xenova/all-MiniLM-L6-v2', ready: true, dims: 384 };
    FakeWorker.onMessage = (m) => ({ id: m.id, ok: true, result: status });

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const result = await embeddings.getEmbedderStatus();

    expect(FakeWorker.latest.messages[0].action).toBe('status');
    expect(result).toEqual(status);
  });

  it('embedTexts sends the embed action with bound texts', async () => {
    const vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
    FakeWorker.onMessage = (m) => ({ id: m.id, ok: true, result: vectors });

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const result = await embeddings.embedTexts(['a', 'b']);

    const message = FakeWorker.latest.messages[0];
    expect(message.action).toBe('embed');
    expect(message.params.texts).toEqual(['a', 'b']);
    expect(result).toEqual(vectors);
  });

  it('passes backend override from location.search to the worker URL', async () => {
    vi.stubGlobal('location', {
      href: 'http://localhost/?embedBackend=wasm',
      search: '?embedBackend=wasm',
    });

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await embeddings.getEmbedderStatus();

    expect(FakeWorker.latest.url.searchParams.get('backend')).toBe('wasm');
  });

  it('per-acquire options override the worker URL, paths, and backend', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder({
      workerUrl: '/custom/worker.js',
      modelPath: '/custom-models/',
      ortPath: '/custom-ort/',
      backend: 'webgpu',
    });
    await embeddings.getEmbedderStatus();

    const url = FakeWorker.latest.url;
    expect(url.pathname).toBe('/custom/worker.js');
    expect(url.searchParams.get('models')).toBe('/custom-models/');
    expect(url.searchParams.get('ort')).toBe('/custom-ort/');
    expect(url.searchParams.get('backend')).toBe('webgpu');
  });

  it('correlates concurrent responses by message id', async () => {
    FakeWorker.onMessage = (m) => {
      if (m.action === 'status') {
        setTimeout(() => {
          FakeWorker.latest.onmessage?.({ data: { id: m.id, ok: true, result: 'status-result' } });
        }, 10);
        return null;
      }
      return { id: m.id, ok: true, result: 'embed-result' };
    };

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const [status, embed] = await Promise.all([embeddings.getEmbedderStatus(), embeddings.embedTexts(['x'])]);

    expect(status).toBe('status-result');
    expect(embed).toBe('embed-result');
  });

  it('routes progress messages to subscribers without resolving requests', async () => {
    FakeWorker.onMessage = () => null;

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const progressEvents = [];
    embeddings.onProgress((p) => progressEvents.push(p));

    const pending = embeddings.embedTexts(['x']);
    const progressPayload = { type: 'progress', status: 'progress', progress: 0.5 };
    FakeWorker.latest.onmessage?.({ data: progressPayload });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toEqual(progressPayload);

    // Progress must not resolve the pending request
    const stillPending = Promise.race([
      pending.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    await expect(stillPending).resolves.toBe('timeout');
  });

  it('rejects when the worker answers with an error', async () => {
    FakeWorker.onMessage = (m) => ({ id: m.id, ok: false, error: 'model not found' });

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await expect(embeddings.embedTexts(['x'])).rejects.toThrow('model not found');
  });

  it('rejects all pending requests when the worker errors catastrophically', async () => {
    FakeWorker.onMessage = () => null;

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const pending = embeddings.embedTexts(['x']);
    const assertion = expect(pending).rejects.toThrow('Embedding worker error: boom');

    FakeWorker.latest.onerror?.({ message: 'boom' });
    await assertion;
  });

  it('keeps the worker alive until the last consumer releases', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    embeddings.acquireEmbedder();

    expect(embeddings.getActiveWorkerCount()).toBe(1);

    await embeddings.releaseEmbedder();
    expect(embeddings.getActiveWorkerCount()).toBe(1);
    expect(FakeWorker.latest.terminated).toBe(false);

    await embeddings.releaseEmbedder();
    expect(embeddings.getActiveWorkerCount()).toBe(0);
    expect(FakeWorker.latest.terminated).toBe(true);
  });

  it('sends dispose before terminating the worker', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await embeddings.releaseEmbedder();

    const actions = FakeWorker.latest.messages.map((m) => m.action);
    expect(actions).toEqual(['dispose']);
    expect(FakeWorker.latest.terminated).toBe(true);
  });

  it('rejects in-flight requests when the last release terminates the worker', async () => {
    FakeWorker.onMessage = (m) => {
      if (m.action === 'dispose') {
        return { id: m.id, ok: true, result: { disposed: true } };
      }
      return null; // leave embed pending
    };

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const pending = embeddings.embedTexts(['x']);
    const assertion = expect(pending).rejects.toThrow('no consumers remain');

    await embeddings.releaseEmbedder();
    await assertion;
    expect(FakeWorker.latest.terminated).toBe(true);
  });

  it('creates a fresh worker when re-acquired after a full release', async () => {
    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    await embeddings.releaseEmbedder();

    expect(FakeWorker.instances).toHaveLength(1);

    embeddings.acquireEmbedder();
    await embeddings.getEmbedderStatus();

    expect(FakeWorker.instances).toHaveLength(2);
    expect(embeddings.getActiveWorkerCount()).toBe(1);
  });

  it('does not reject requests on a re-acquired worker during the old worker teardown', async () => {
    // The dispose response is delayed so the release teardown overlaps
    // with a fresh acquire + request on the new worker.
    FakeWorker.onMessage = (m, workerInstance) => {
      if (m.action === 'dispose') {
        setTimeout(() => {
          workerInstance.onmessage?.({ data: { id: m.id, ok: true, result: { disposed: true } } });
        }, 50);
        return null;
      }
      return { id: m.id, ok: true, result: 'ok' };
    };

    const embeddings = await importEmbeddingsModule();
    embeddings.acquireEmbedder();
    const oldWorker = FakeWorker.latest;

    const release = embeddings.releaseEmbedder();

    // Re-acquire while the old worker is still being disposed.
    embeddings.acquireEmbedder();
    const newWorker = FakeWorker.latest;
    expect(newWorker).not.toBe(oldWorker);

    const status = embeddings.getEmbedderStatus();
    await release;

    // The new worker's request must resolve despite the old worker's
    // teardown rejecting its own pending requests.
    await expect(status).resolves.toBe('ok');
    expect(oldWorker.terminated).toBe(true);
    expect(newWorker.terminated).toBe(false);
  });

  it('cosineSimilarity returns 1 for identical normalized vectors', async () => {
    const embeddings = await importEmbeddingsModule();
    const a = [0.6, 0.8];
    expect(embeddings.cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it('cosineSimilarity returns 0 for orthogonal vectors', async () => {
    const embeddings = await importEmbeddingsModule();
    const a = [1, 0];
    const b = [0, 1];
    expect(embeddings.cosineSimilarity(a, b)).toBe(0);
  });

  it('cosineSimilarity computes a known 3-D dot product', async () => {
    const embeddings = await importEmbeddingsModule();
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    expect(embeddings.cosineSimilarity(a, b)).toBe(32);
  });

  it('cosineSimilarity throws for mismatched lengths', async () => {
    const embeddings = await importEmbeddingsModule();
    expect(() => embeddings.cosineSimilarity([1, 2], [1])).toThrow('equal length');
  });

  it('cosineSimilarity throws for non-arrays', async () => {
    const embeddings = await importEmbeddingsModule();
    expect(() => embeddings.cosineSimilarity(null, [1])).toThrow('arrays');
  });
});
