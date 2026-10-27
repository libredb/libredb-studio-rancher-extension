/**
 * Flat ESLint config for a Rancher UI extension.
 *
 * The shared ruleset + eslint toolchain (eslint, neostandard, typescript-eslint, eslint-plugin-vue,
 * ...) are provided by `@rancher/shell`, so this file just re-exports the shared config and adds any
 * project-specific overrides.
 *
 * Linting runs through `@rancher/shell`'s launcher (see the `lint` script in package.json), which
 * selects ESLint 10 for this flat config. Extensions that still use a legacy `.eslintrc.*` file are
 * instead linted with the shipped ESLint 7 toolchain — see the extension ESLint documentation.
 */
import globals from 'globals';
import pluginJest from 'eslint-plugin-jest';
import shellConfig from '@rancher/shell/eslint.config.base.mjs';

export default [
  ...shellConfig,

  // Unit tests. `globals` and `eslint-plugin-jest` come from `@rancher/shell`, the same way as the
  // rest of the eslint toolchain. Without this, `describe`/`it`/`expect`/`jest` are reported as
  // undefined in every test file.
  {
    files: [
      '**/__tests__/**/*.{js,ts}',
      '**/*.{spec,test}.{js,ts}',
      'jest.config.js',
      'jest.setup.js',
    ],
    ignores:         ['cypress/**'],
    plugins:         { jest: pluginJest },
    languageOptions: { globals: { ...globals.jest } },
    rules:           {
      ...pluginJest.configs['flat/recommended'].rules,
      'jest/no-commented-out-tests': 'off',
      'jest/no-disabled-tests':      'off',
    },
  },

  // End-to-end specs run in Cypress, on mocha, not in Jest.
  {
    files:           ['cypress/**/*.ts', 'cypress.config.ts'],
    languageOptions: {
      globals: {
        ...globals.mocha,
        cy:      'readonly',
        Cypress: 'readonly',
      },
    },
  },

  // Project rules: the extension never logs (a log line can carry a resource or a secret into the
  // browser console) and never evaluates code.
  {
    files: ['pkg/**/*.{js,ts,vue}'],
    rules: {
      'no-console':      'error',
      'no-eval':         'error',
      'no-implied-eval': 'error',
      'no-new-func':     'error',
    },
  },
];
