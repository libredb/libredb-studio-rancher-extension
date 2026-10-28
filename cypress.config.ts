// End-to-end tests against a real Rancher, on @rancher/cypress's base configuration.
// Connection settings come from the environment, never from the repository:
//   TEST_BASE_URL   Rancher's dashboard URL, for example https://rancher.example.sslip.io/dashboard
//   TEST_USERNAME   a Rancher user (defaults to admin)
//   TEST_PASSWORD   that user's password
//   TEST_SKIP=setup the Rancher is already set up, so @rancher/cypress's first-login specs are skipped
//   LIBREDB_PKG_URL where the built package is served
//   LIBREDB_CHART_REPO_URL where Rancher reaches the extension's Helm repository; the spec that
//                   installs from the Extensions page is skipped without it
// scripts/e2e/run.sh sets all of them for the local lab.
import baseConfig from '@rancher/cypress/base-config';
import { extendConfig } from '@rancher/cypress/extend-config';

// @rancher/cypress's setup spec also counts the settings requests of the dashboard bundled in the
// Rancher image, a check of that dashboard build rather than of this extension, which fails on
// rancher/rancher:v2.15-head. Only that test is left out; the first-login tests still run.
// An inverted title filter needs grepFilterSpecs off; TEST_ONLY already picks the spec folders.
const SKIPPED_UPSTREAM_TEST = 'Confirm correct number of settings requests made';

export default extendConfig({
  env: {
    libredbPkgUrl:       (process.env.LIBREDB_PKG_URL || 'http://127.0.0.1:4500').replace(/\/$/, ''),
    libredbChartRepoUrl: (process.env.LIBREDB_CHART_REPO_URL || '').replace(/\/$/, ''),
  },
  expose: {
    ...baseConfig.expose,
    grepFilterSpecs: false,
    grep:            `-${ SKIPPED_UPSTREAM_TEST }`,
  },
  e2e: { supportFile: './cypress/support/e2e.ts' },
});
