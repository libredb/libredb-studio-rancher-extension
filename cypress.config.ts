// End-to-end tests against a real Rancher, on @rancher/cypress's base configuration.
// Connection settings come from the environment, never from the repository:
//   TEST_BASE_URL   Rancher's dashboard URL, for example https://rancher.example.sslip.io/dashboard
//   TEST_USERNAME   a Rancher user (defaults to admin)
//   TEST_PASSWORD   that user's password
//   TEST_SKIP=setup the Rancher is already set up, so @rancher/cypress's first-login specs are skipped
//   LIBREDB_PKG_URL where the built package is served
// scripts/e2e/run.sh sets all of them for the local lab.
import { extendConfig } from '@rancher/cypress/extend-config';

export default extendConfig({
  env: { libredbPkgUrl: (process.env.LIBREDB_PKG_URL || 'http://127.0.0.1:4500').replace(/\/$/, '') },
  e2e: { supportFile: './cypress/support/e2e.ts' },
});
