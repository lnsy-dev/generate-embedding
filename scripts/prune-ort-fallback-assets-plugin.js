/**
 * PruneOrtFallbackAssetsPlugin
 *
 * Removes the webpack-emitted ONNX Runtime fallback assets (content-hashed
 * .wasm / .mjs files at the output root) from a compilation.
 *
 * @huggingface/transformers references the ORT binaries as webpack asset
 * modules, but at runtime those references are only evaluated when ORT has
 * no `locateFile` override. The component always sets
 * `env.backends.onnx.wasm.wasmPaths` from its `ort-path` attribute, so the
 * emitted fallbacks are dead weight — up to 24 MB in dist/ and in the
 * published npm package.
 */

/**
 * Remove emitted wasm/mjs fallback assets from the compilation.
 */
class PruneOrtFallbackAssetsPlugin {
  /**
   * Tap the compilation's processAssets hook.
   *
   * @param {import('webpack').Compiler} compiler The webpack compiler
   * @returns {void}
   */
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('PruneOrtFallbackAssetsPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'PruneOrtFallbackAssetsPlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
        },
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

export default PruneOrtFallbackAssetsPlugin;
