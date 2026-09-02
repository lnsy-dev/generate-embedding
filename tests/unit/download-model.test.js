/**
 * Download Model Script Unit Tests
 *
 * Unit tests for scripts/download-model.js — the postinstall script that
 * downloads model weights and copies ONNX Runtime binaries. These tests
 * pin down:
 *   - hoisting-aware onnxruntime-web resolution (findOrtSource)
 *   - ORT binary copying (copyOrtFiles) filter and target behavior
 *   - the packaging invariant: the postinstall script must ship in the
 *     npm tarball (listed in package.json `files`), which was the root
 *     cause of a broken `npm install` in 0.1.0
 *   - the npm postinstall invocation path: the script must run cleanly
 *     under plain `node` with GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findOrtSource, copyOrtFiles } from '../../scripts/download-model.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'download-model.js');

/**
 * Create a fake onnxruntime-web package install.
 *
 * @param {string} packageDir - Directory to create the package in
 * @param {string} marker - Marker text used to tell installs apart
 * @returns {string} Absolute path to the fake dist directory
 */
function createFakeOrtInstall(packageDir, marker) {
  const distDir = path.join(packageDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'onnxruntime-web',
      version: '1.29.0',
      main: './dist/ort.min.js',
      exports: {
        '.': {
          node: { import: './dist/ort.node.min.mjs', require: './dist/ort.min.js' },
          import: './dist/ort.bundle.min.mjs',
          require: './dist/ort.min.js',
        },
      },
    })
  );
  fs.writeFileSync(path.join(distDir, 'ort.min.js'), marker);
  fs.writeFileSync(path.join(distDir, 'ort-wasm-simd-threaded.wasm'), marker);
  fs.writeFileSync(path.join(distDir, 'ort-wasm-simd-threaded.mjs'), marker);
  // Must be ignored by the copy filter.
  fs.writeFileSync(path.join(distDir, 'ort.min.js.map'), marker);
  fs.writeFileSync(path.join(distDir, 'unrelated.txt'), marker);
  return distDir;
}

/**
 * Build a fixture project layout on disk.
 *
 * @param {string|null} hoisted - Whether to include a hoisted onnxruntime-web
 * @param {string|null} nested - Whether to include a nested onnxruntime-web
 * @returns {{projectDir: string, hoistedDist: string|null, nestedDist: string|null}}
 */
function createFixture({ hoisted = null, nested = null }) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-ort-fixture-'));
  const hoistedDist = hoisted
    ? createFakeOrtInstall(path.join(projectDir, 'node_modules', 'onnxruntime-web'), 'hoisted')
    : null;
  const nestedDist = nested
    ? createFakeOrtInstall(
        path.join(projectDir, 'node_modules', 'generate-embedding', 'node_modules', 'onnxruntime-web'),
        'nested'
      )
    : null;
  return { projectDir, hoistedDist, nestedDist };
}

describe('findOrtSource', () => {
  it('resolves a hoisted onnxruntime-web install (typical consumer layout)', () => {
    const { projectDir, hoistedDist } = createFixture({ hoisted: true });
    // require.resolve returns the realpath, which can differ from os.tmpdir()
    // via the /var -> /private/var symlink on macOS.
    expect(findOrtSource(projectDir)).toBe(fs.realpathSync(hoistedDist));
  });

  it('prefers a nested install over a hoisted one', () => {
    const { projectDir, nestedDist } = createFixture({ hoisted: true, nested: true });
    const consumerPkgDir = path.join(projectDir, 'node_modules', 'generate-embedding');
    expect(findOrtSource(consumerPkgDir)).toBe(fs.realpathSync(nestedDist));
  });

  it('returns null when onnxruntime-web is not installed', () => {
    const { projectDir } = createFixture({});
    expect(findOrtSource(projectDir)).toBeNull();
  });
});

describe('copyOrtFiles', () => {
  /** @type {string} */
  let targetDir;

  beforeAll(() => {
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-ort-target-'));
  });

  it('copies only ort-*.wasm and ort-*.mjs files into the target directory', () => {
    const { hoistedDist } = createFixture({ hoisted: true });
    copyOrtFiles({ sourceDir: hoistedDist, targetDir });

    const copied = fs.readdirSync(targetDir).sort();
    expect(copied).toEqual(['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
    expect(fs.readFileSync(path.join(targetDir, 'ort-wasm-simd-threaded.wasm'), 'utf8')).toBe('hoisted');
  });

  it('is a no-op when the source directory does not exist', () => {
    const emptyTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-ort-empty-'));
    copyOrtFiles({ sourceDir: path.join(emptyTarget, 'missing'), targetDir: emptyTarget });
    expect(fs.readdirSync(emptyTarget)).toEqual([]);
  });
});

describe('packaging invariant', () => {
  it('ships the postinstall script: every node script in package.json is published via `files`', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const scriptTargets = [...pkg.scripts.postinstall.matchAll(/(scripts\/[\w.-]+\.js)/g)].map((m) => m[1]);
    expect(scriptTargets.length).toBeGreaterThan(0);

    for (const target of scriptTargets) {
      // Must exist in the repo...
      expect(fs.existsSync(path.join(repoRoot, target)), `${target} exists in repo`).toBe(true);
      // ...and be listed in `files` so it lands in the published tarball.
      const isListed = pkg.files.some((entry) => entry === target || entry === path.dirname(target) + '/');
      expect(isListed, `${target} is listed in package.json files`).toBe(true);
    }
  });
});

describe('postinstall invocation', () => {
  it('runs cleanly under plain node with GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=1', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('skipping');
  });
});
