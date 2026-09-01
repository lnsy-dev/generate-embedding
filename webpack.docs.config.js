import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import baseConfig from './webpack.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 *   - no HtmlWebpackPlugin: docs/index.html is hand-written and loads
 *     ./main.min.js with a relative URL
 *   - no CopyWebpackPlugin: the ~140 MB models/ and ort/ directories are
 *     NOT copied. The demo relies on the documented fallbacks (Hugging
 *     Face hub for model weights, jsdelivr CDN for ORT wasm binaries)
 *     unless a self-hosted copy is placed in docs/models/ and docs/ort/.
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
    new PruneOrtFallbackAssetsPlugin(),
  ],
};
