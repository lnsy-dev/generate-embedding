import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import fs from 'fs';
import PruneOrtFallbackAssetsPlugin from './scripts/prune-ort-fallback-assets-plugin.js';
import webpack from 'webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load environment variables from .env file.
 * This allows users to customize build behavior without modifying
 * the webpack config directly.
 */
dotenv.config();

const outputFileName = process.env.OUTPUT_FILE_NAME || 'main.min.js';
const separateCss = process.env.SEPARATE_CSS === 'true';
const port = process.env.PORT || 3000;

/**
 * Check if assets directory exists and has files.
 * We only add CopyWebpackPlugin if there are actual assets to copy,
 * avoiding unnecessary build overhead for projects without static files.
 */
const assetsPath = path.join(__dirname, 'assets');
const hasAssets = (() => {
  try {
    return fs.existsSync(assetsPath) && fs.readdirSync(assetsPath).length > 0;
  } catch {
    return false;
  }
})();

/**
 * Check for the downloaded model / ORT runtime directories (populated by
 * the postinstall script). They are copied into dist/ only when present,
 * so builds before the first `npm install` download still succeed.
 */
const hasModels = fs.existsSync(path.join(__dirname, 'models'));
const hasOrt = fs.existsSync(path.join(__dirname, 'ort'));

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Webpack Configuration
 *
 * This configuration is designed for vanilla JavaScript projects with:
 * - Modern CSS processing (PostCSS + cssnano)
 * - Fast JavaScript transpilation (SWC)
 * - Web Worker bundling for the embedding worker
 * - Static asset copying
 * - Environment-based customization
 */
export default {
  entry: {
    main: './index.js',
    /**
     * Embedding worker is built as a separate entry so webpack bundles
     * the ESM-only @huggingface/transformers dependency into a classic
     * script. Webpack's native `new Worker(new URL(...))` handling emits
     * module-worker auxiliary chunks that keep bare npm imports, which
     * fail in the browser without import maps.
     *
     * Because the worker runs in a DedicatedWorkerGlobalScope, its dynamic
     * import() chunks must be loaded with importScripts() instead of the
     * default document.createElement('script') used for the web target.
     * wasmLoading stays 'fetch', which is valid in workers.
     */
    'generate-embedding-worker': {
      import: './src/embed-worker.js',
      chunkLoading: 'import-scripts',
      wasmLoading: 'fetch',
    },
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: (pathData) => {
      // Keep the worker at a stable URL; use the configured name for main.
      if (pathData.chunk.name === 'generate-embedding-worker') {
        return 'generate-embedding-worker.js';
      }
      return isDev ? '[name].js' : outputFileName;
    },
    /**
     * Additional chunks need their own filename pattern so they do not
     * collide with the fixed entry filename above.
     */
    chunkFilename: isDev ? '[name].js' : 'chunks/[name].min.js',
    clean: true,
    publicPath: '/',
  },
  mode: isDev ? 'development' : 'production',

  devServer: {
    static: [
      {
        directory: path.join(__dirname, 'assets'),
        publicPath: '/',
      },
      // Locally served model + ORT runtime files (downloaded by postinstall)
      {
        directory: path.join(__dirname, 'models'),
        publicPath: '/models/',
      },
      {
        directory: path.join(__dirname, 'ort'),
        publicPath: '/ort/',
      },
    ],
    /**
     * Disable the dev-server client entirely. Even with hot/liveReload off,
     * the client runtime is injected into every entry and overrides the
     * Worker constructor so the embedding worker would run in the main
     * thread instead of a real web worker. Manual refresh in development
     * is fine for a vanilla JS app.
     */
    client: false,
    port: port,
    hot: false,
    liveReload: false,
    open: false,
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          separateCss ? MiniCssExtractPlugin.loader : 'style-loader',
          {
            loader: 'css-loader',
            options: isDev ? {} : {
              importLoaders: 1,
              modules: false,
            }
          },
          {
            loader: 'postcss-loader',
            options: isDev ? {} : {
              postcssOptions: {
                plugins: [
                  ['cssnano', {
                    preset: ['default', {
                      discardComments: {
                        removeAll: true,
                      },
                    }],
                  }],
                ],
              },
            }
          }
        ],
      },
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: [
          {
            loader: path.resolve(__dirname, 'scripts/transform-workers.js'),
          },
          {
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: {
                  syntax: 'ecmascript',
                },
                target: 'es2015',
              },
            },
          },
        ],
      },

    ],
  },
  optimization: {
    splitChunks: false,
    /**
     * Each entry keeps its own runtime chunk. Sharing a single runtime
     * between the main bundle and the embedding worker would force the
     * worker to use the web target's jsonp chunk loader, which touches
     * `document` and fails in a worker — and with `runtimeChunk: 'single'`
     * the worker entry is never executed at all, since the shared runtime
     * lives in a separate file the worker never loads.
     */
    runtimeChunk: false,
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
      filename: 'index.html',
      /**
       * Only inject the main entry into index.html. The worker entry is
       * loaded at runtime via new Worker('/generate-embedding-worker.js');
       * injecting it as a <script> would execute the worker code in the
       * main thread (Window context) and break the request/response
       * protocol.
       */
      chunks: ['main'],
    }),
    new HtmlWebpackPlugin({
      template: './demo.html',
      filename: 'demo.html',
      chunks: ['main'],
    }),
    ...(separateCss ? [new MiniCssExtractPlugin()] : []),
    ...((hasAssets || hasModels || hasOrt)
      ? [
          new CopyWebpackPlugin({
            patterns: [
              ...(hasAssets
                ? [
                    {
                      from: 'assets',
                      to: '.',
                    },
                  ]
                : []),
              // Locally served model + ORT runtime files (downloaded by postinstall)
              ...(hasModels
                ? [
                    {
                      from: 'models',
                      to: 'models',
                    },
                  ]
                : []),
              ...(hasOrt
                ? [
                    {
                      from: 'ort',
                      to: 'ort',
                    },
                  ]
                : []),
            ],
          }),
        ]
      : []),
    // The ORT fallback assets are dead weight: the component always sets
    // wasmPaths from its ort-path attribute, so ORT never fetches the
    // webpack-emitted copies. Keeps dist/ and the npm package slim.
    new PruneOrtFallbackAssetsPlugin(),
    // Merge the worker's dynamic @huggingface/transformers chunk into the
    // worker entry, so dist/generate-embedding-worker.js is a single
    // self-contained file. Consumers copy exactly one worker file; without
    // this, the worker importScripts()es chunks/ at the domain root and
    // 404s unless hosts know to copy that directory too.
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
  ],
};
