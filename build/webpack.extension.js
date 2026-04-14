/**
 * build/webpack.extension.js
 * Webpack configuration for building the Eruda Cromite browser extension.
 *
 * Entry points:
 *   background     → extension/background.js (Service Worker — module type)
 *   content-script → extension/content-script.js
 *   popup          → extension/popup/popup.js
 *   options        → extension/options/options.js
 *
 * Output: extension-dist/
 * Static assets (manifest, CSS, HTML, icons, _locales) are copied verbatim.
 */

const path = require('path')
const fs = require('fs')
const webpack = require('webpack')
const CopyPlugin = require('copy-webpack-plugin')
const pkg = require('../package.json')

const EXT_SRC = path.resolve(__dirname, '../extension')
const EXT_OUT = path.resolve(__dirname, '../extension-dist')
const ERUDA_DIST = path.resolve(__dirname, '../dist/eruda.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the eruda production bundle exists.
 * If not we fall back to the dev server bundle path so the extension can still
 * be loaded in developer mode by running `npm run dev` in a separate terminal.
 */
const erudaSrc = fs.existsSync(ERUDA_DIST)
  ? ERUDA_DIST
  : path.resolve(__dirname, '../dist/eruda.js')

// ---------------------------------------------------------------------------
// Webpack config
// ---------------------------------------------------------------------------
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  entry: {
    background: path.join(EXT_SRC, 'background.js'),
    'content-script': path.join(EXT_SRC, 'content-script.js'),
    'popup/popup': path.join(EXT_SRC, 'popup/popup.js'),
    'options/options': path.join(EXT_SRC, 'options/options.js'),
  },

  output: {
    path: EXT_OUT,
    filename: '[name].js',
    // ES modules so the background service worker can use import/export
    // (Manifest V3 service workers support module type in Chromium 116+)
    module: true,
    chunkFormat: 'module',
    library: {
      type: 'module',
    },
  },

  experiments: {
    outputModule: true,
  },

  resolve: {
    extensions: ['.js'],
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        include: [EXT_SRC],
        use: [
          {
            loader: 'babel-loader',
            options: {
              sourceType: 'module',
              presets: [
                [
                  '@babel/preset-env',
                  {
                    // Target Chromium 120+ (Cromite base)
                    targets: { chrome: '120' },
                    modules: false, // keep ES modules
                  },
                ],
              ],
              plugins: ['@babel/plugin-proposal-class-properties'],
            },
          },
        ],
      },
    ],
  },

  plugins: [
    new webpack.DefinePlugin({
      VERSION: JSON.stringify(pkg.version),
    }),

    new CopyPlugin({
      patterns: [
        // Manifest
        { from: path.join(EXT_SRC, 'manifest.json'), to: EXT_OUT },

        // HTML pages (popup + options)
        { from: path.join(EXT_SRC, 'popup/popup.html'), to: path.join(EXT_OUT, 'popup') },
        { from: path.join(EXT_SRC, 'popup/popup.css'), to: path.join(EXT_OUT, 'popup') },
        { from: path.join(EXT_SRC, 'options/options.html'), to: path.join(EXT_OUT, 'options') },
        { from: path.join(EXT_SRC, 'options/options.css'), to: path.join(EXT_OUT, 'options') },

        // Icons
        { from: path.join(EXT_SRC, 'icons'), to: path.join(EXT_OUT, 'icons') },

        // Locales
        { from: path.join(EXT_SRC, '_locales'), to: path.join(EXT_OUT, '_locales') },

        // Eruda library bundle (built by `npm run build` first)
        {
          from: erudaSrc,
          to: path.join(EXT_OUT, 'lib', 'eruda.js'),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],

  optimization: {
    // Keep each entry as its own chunk (no runtime chunk — not compatible with MV3 module SW)
    runtimeChunk: false,
    splitChunks: false,
    minimize: process.env.NODE_ENV === 'production',
  },
}
