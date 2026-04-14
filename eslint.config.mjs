import babelEslintParser from '@babel/eslint-parser'
import eslintJs from '@eslint/js'
import globals from 'globals'

export default [
  eslintJs.configs.recommended,
  {
    languageOptions: {
      parser: babelEslintParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
        },
      },
      globals: {
        ...globals.builtin,
        ...globals.browser,
        ...globals.commonjs,
        VERSION: true,
        ENV: true,
      },
    },
    rules: {
      quotes: ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': false }],
      'prefer-const': 2,
    },
  },
  {files: ['build/**/*.js'], languageOptions:{globals: {...globals.node}}},
  {
    // Chrome extension source files: expose the `chrome` extension API global
    // and relax rules that are incompatible with embedded code strings.
    files: ['extension/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.builtin,
        chrome: 'readonly',
        eruda: 'readonly',
      },
    },
    rules: {
      'no-new-func': 'off',
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
  {
    ignores: ['test', 'dist', 'coverage', 'extension-dist', 'extension/test'],
  },
]
