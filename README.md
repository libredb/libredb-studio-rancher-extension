# LibreDB Studio extension for Rancher Manager

This repository holds the Rancher Manager UI extension for [LibreDB Studio](https://github.com/libredb/libredb-studio), the web-based SQL IDE, so that Rancher users can find, set up and open the databases in their clusters from native Rancher pages.
Status: in development, not yet listed in any extension catalog, and not ready for production use.

## Compatibility

| Rancher | Shell | Declared |
| --- | --- | --- |
| 2.15 and later | 3.x | Yes, the floor |
| 2.14 and earlier | 3.x | No |

The extension is built against `@rancher/shell` 3.0.14 and declares `catalog.cattle.io/rancher-version: ">= 2.15.0-0"` with no upper bound, and Kubernetes 1.26 or later.

## Development

Requirements: Node.js 24.15 or later (see `.nvmrc`) and Yarn 1.

```bash
yarn install --frozen-lockfile
yarn lint                       # ESLint through @rancher/shell's launcher, warnings fail
yarn typecheck                  # vue-tsc over pkg/libredb-studio, .vue files included
yarn test:coverage              # Jest, fails below 100% line coverage of pkg/libredb-studio
yarn build-pkg libredb-studio   # builds dist-pkg/libredb-studio-<version>
yarn serve-pkgs                 # serves dist-pkg on http://127.0.0.1:4500 for Developer Load
```

To try a build in a Rancher, turn on Extension developer features in your user preferences, open Extensions, choose Developer Load and enter the URL that `yarn serve-pkgs` prints.

The setup wizard installs and upgrades the LibreDB Studio chart from Rancher's Partners repository only, never from a repository a setup record names.
A development or lab build may name another ClusterRepo at build time, for a chart that Partners does not carry yet:

```bash
VUE_APP_LIBREDB_DEV_REPO=my-lab-charts yarn build-pkg libredb-studio
```

No workflow of this repository sets it, which a unit test checks, so the published builds name none.

### End-to-end tests

The Cypress specs under `cypress/` run on [`@rancher/cypress`](https://www.npmjs.com/package/@rancher/cypress) against a real Rancher:

```bash
TEST_BASE_URL=https://rancher.example.sslip.io/dashboard TEST_PASSWORD=... yarn e2e
```

`scripts/e2e/run.sh` builds and serves the package, then runs the specs; by default it assumes Rancher is already set up and skips the first-login specs.
With `LAB_ENV` pointing at a local lab's environment file that exports `RANCHER_URL` and `LAB_SECRETS`, it signs in as that lab's admin.
The `E2E` workflow runs the same specs on a fresh `rancher/rancher:v2.15-head` started on the runner, on every pull request and push to `main`; run it by hand from the Actions tab to pick another Rancher image.

`package.json` holds `@yarnpkg/core` at 4.9.1 through `resolutions`: 4.9.2 was published with a Yarn Berry `patch:` dependency that Yarn 1 cannot resolve, and `@rancher/cypress` pulls it in through `@percy/cli`.
Drop the entry once a later `@yarnpkg/core` installs under Yarn 1.

## Licence

MIT, see [LICENSE](LICENSE).
