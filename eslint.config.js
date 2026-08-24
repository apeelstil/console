const js = require('@eslint/js');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefreshModule = require('eslint-plugin-react-refresh');
const reactRefresh = reactRefreshModule.default ?? reactRefreshModule;
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist', 'dist-electron', 'dist-test', 'release', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['electron/**/*.ts', 'shared/**/*.ts', 'tests/**/*.ts', '*.config.{js,ts,mts}'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
