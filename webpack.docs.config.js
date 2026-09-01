import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import webpack from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import baseConfig from './webpack.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Repo-root asset directories downloaded by the postinstall script. They are
 * copied into docs/ so the GitHub Pages demo is fully self-hosted: every
 * request (page, worker, model weights, ORT wasm binaries) stays same-origin
 * and CORS can never enter the picture.
 */
const hasModels = fs.existsSync(path.resolve(__dirname, 'models'));
const hasOrt = fs.existsSync(path.resolve(__dirname, 'ort'));

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
 * Prune fallback wasm/mjs assets from the docs build.
 *
 * The @huggingface/transformers bundle references the ONNX Runtime
 * binaries as webpack asset modules. At runtime those references are only
 * evaluated when ORT has no `locateFile` override — but the component
 * always sets `env.backends.onnx.wasm.wasmPaths` from the `ort-path`
 * attribute, so the assets are never fetched. The docs demo points
 * `ort-path` at the jsdelivr CDN, so these multi-megabyte fallback files
 * are pruned to keep the committed docs/ directory small.
 */
class PruneOrtFallbackAssetsPlugin {
  /**
   * Remove emitted wasm/mjs fallback assets from the compilation.
   *
   * @param {import('webpack').Compiler} compiler The webpack compiler
   * @returns {void}
   */
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('PruneOrtFallbackAssetsPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'PruneOrtFallbackAssetsPlugin', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE },
        (assets) => {
          for (const name of Object.keys(assets)) {
            // Asset-module emissions are named by content hash (e.g.
            // bb191ad2bb217f542c38.wasm); the bundle's own outputs always
            // carry meaningful names.
            if (/^[0-9a-f]{16,32}\.(wasm|mjs)$/.test(name)) {
              compilation.deleteAsset(name);
            }
          }
        },
      );
    });
  }
}

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
    ...(hasModels || hasOrt
      ? [
          new CopyWebpackPlugin({
            patterns: [
              ...(hasModels ? [{ from: 'models', to: 'models' }] : []),
              ...(hasOrt ? [{ from: 'ort', to: 'ort', filter: skipJspi }] : []),
            ],
          }),
        ]
      : []),
    new PruneOrtFallbackAssetsPlugin(),
  ],
};
