// First login and first-run configuration of a fresh Rancher, from @rancher/cypress. CI runs it
// before the extension specs; a local run against an already set up Rancher skips it (TEST_SKIP=setup).
import '@rancher/cypress/e2e/tests/setup/rancher-setup.spec';
