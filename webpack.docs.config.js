import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import PruneOrtFallbackAssetsPlugin from './scripts/prune-ort-fallback-assets-plugin.js';
import baseConfig from './webpack.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Repo-root asset directories downloaded by the postinstall script. They are
 * copied into docs/ so the GitHub Pages demo is fully self-hosted: every
 * request (page, worker, model weights, ORT wasm binaries) stays same-origin
 * and CORS can never enter the picture.
 *
 * The docs build fails when they are missing: silently publishing a demo
 * that falls back to the Hugging Face hub / CDN is exactly the failure mode
 * (CORS errors on deployment) this build exists to prevent. Run
 * `npm install` first, or set GENERATE_EMBEDDING_SKIP_MODEL_DOWNLOAD=0 and
 * reinstall, to fetch the assets.
 */
const modelsDir = path.resolve(__dirname, 'models');
const ortDir = path.resolve(__dirname, 'ort');
const hasModels = fs.existsSync(modelsDir);
const hasOrt = fs.existsSync(ortDir);

if (!hasModels || !hasOrt) {
  const missing = [
    ...(hasModels ? [] : [`models/ (${modelsDir})`]),
    ...(hasOrt ? [] : [`ort/ (${ortDir})`]),
  ];
  throw new Error(
    `build:docs requires the self-hosted runtime assets, which are missing: ${missing.join(', ')}. `
    + 'Run `npm install` (the postinstall script downloads them), then rebuild.',
  );
}

/**
 * Prune the experimental JSPI ORT variant from the copied runtime. It is
 * only used when JavaScript Promise Integration is explicitly enabled, so
 * the plain, asyncify, and jsep variants cover both the WASM and WebGPU
 * backends.
 *
 * @param {string} assetPath - Source path of the file being copied
 * @returns {boolean} False when the file should be skipped
 */
const skipJspi = (assetPath) => !assetPath.includes('.jspi.');

/**
 * GitHub Pages docs build.
 *
 * Produces a static bundle in docs/ that works when served from a
 * sub-path (https://<user>.github.io/<repo>/):
 *   - publicPath 'auto' so any runtime asset URL resolves relative to the
 *     script that loaded it, not the domain root
 *   - LimitChunkCountPlugin merges the dynamic @huggingface/transformers
 *     chunk into the worker entry, so the worker is a single
 *     self-contained file with no importScripts() chunk loading
 *   - models/ and ort/ are copied in, making the demo fully self-hosted:
 *     zero cross-origin requests, no CDN, no Hugging Face hub fallback
 *   - no HtmlWebpackPlugin: docs/index.html is hand-written and loads
 *     ./main.min.js with a relative URL
 *
 * Usage: npm run build:docs
 */
export default {
  ...baseConfig,
  output: {
    ...baseConfig.output,
    path: path.resolve(__dirname, 'docs'),
    publicPath: 'auto',
    // docs/ contains committed files (index.html); never wipe it.
    clean: false,
  },
  plugins: [
    // Merge async chunks into their entry. The worker entry ends up as a
    // single generate-embedding-worker.js with the whole transformers
    // runtime inlined.
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    // Self-hosted runtime assets: model weights (q8 for WASM, fp16 for
    // WebGPU) and ORT wasm binaries, minus the experimental JSPI variant.
    new CopyWebpackPlugin({
      patterns: [
        { from: modelsDir, to: 'models' },
        { from: ortDir, to: 'ort', filter: skipJspi },
      ],
    }),
    new PruneOrtFallbackAssetsPlugin(),
  ],
};
