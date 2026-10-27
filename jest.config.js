process.env.TZ = 'UTC';

module.exports = {
  testEnvironment:        'jsdom',
  // Jest 28+ (jest-environment-jsdom) defaults package resolution to the "browser" export
  // condition, which makes packages like @vue/test-utils resolve their browser (global-Vue)
  // build and throw "Vue is not defined". Pin to node conditions to restore Jest 27 behaviour.
  testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] },
  setupFilesAfterEnv:     ['<rootDir>/jest.setup.js'],
  watchman:               false,

  moduleFileExtensions: ['js', 'mjs', 'ts', 'json', 'vue'],

  modulePaths:      ['<rootDir>'],
  moduleNameMapper: {
    '^~/(.*)$':                                                                      '<rootDir>/$1',
    '^@/(.*)$':                                                                      '<rootDir>/$1',
    '^@pkg/(.*)$':                                                                   '<rootDir>/pkg/$1',
    '^@shell/(.*)$':                                                                 '<rootDir>/node_modules/@rancher/shell/$1',
    '^@components/(.*)$':                                                            '<rootDir>/node_modules/@rancher/shell/rancher-components/$1',
    // Virtual module created by webpack at build time - see autoImportStub.js
    '^@rancher/auto-import$':                                                        '<rootDir>/autoImportStub.js',
    '\\.(jpe?g|png|gif|webp|svg|mp4|webm|ogg|mp3|wav|flac|aac|woff2?|eot|ttf|otf)$': '<rootDir>/svgTransform.js',
  },

  modulePathIgnorePatterns: ['<rootDir>/cypress/', '<rootDir>/dist-pkg/'],

  transform: {
    '^.+\\.vue$':    '<rootDir>/vue3JestRegisterTs.js',
    // `sourceMap` - the scaffold's tsconfig turns source maps off, which makes @vue/vue3-jest hand
    // @babel/core an empty `inputSourceMap` that newer Babel versions reject. Re-enable for Jest only.
    // `isolatedModules` - skip full type checking during test runs; `yarn lint` / `tsc` cover that.
    '^.+\\.tsx?$':   ['ts-jest', { tsconfig: { sourceMap: true, isolatedModules: true } }],
    '^.+\\.m?jsx?$': ['babel-jest', {
      configFile: false,
      presets:    [['@babel/preset-env', { targets: { node: 'current' } }]]
    }],
    '^.+\\.svg$': '<rootDir>/svgTransform.js'
  },

  // Most of node_modules ships CommonJS and does not need transforming. These packages (pulled in
  // by @rancher/shell) are ESM-only, so Jest has to transpile them instead of skipping them.
  transformIgnorePatterns: [
    '/node_modules/(?!(@rancher/shell|color|color-string|color-convert|color-name|vee-validate|@vee-validate|clipboard-polyfill|intl-messageformat|@formatjs|@replit/codemirror-vim-core)/)',
  ],

  testMatch: ['**/__tests__/**/*.test.ts'],

  coverageProvider:    'v8',
  coverageDirectory:   '<rootDir>/coverage/unit',
  coverageReporters:   ['json', 'lcov', 'text', 'text-summary'],
  collectCoverage:     false,
  // Every source file of the package counts, loaded by a test or not, so an untested file shows
  // up as 0% instead of disappearing from the report. Build configs and tests are not source.
  collectCoverageFrom: [
    '<rootDir>/pkg/libredb-studio/**/*.{vue,ts,js}',
    '!<rootDir>/pkg/libredb-studio/**/__tests__/**',
    '!<rootDir>/pkg/libredb-studio/**/*.d.ts',
    '!<rootDir>/pkg/libredb-studio/{babel,vue}.config.js',
    '!<rootDir>/pkg/libredb-studio/.shell/**',
  ],
  // The repository's rule: 100% line coverage of the extension package, enforced in CI.
  coverageThreshold: { global: { lines: 100 } },
};
