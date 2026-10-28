# Releasing

A release publishes the extension in two forms, each from a GitHub release:

| What | Tag | Workflow | Where it lands |
| --- | --- | --- | --- |
| Extension chart | `libredb-studio-<version of pkg/libredb-studio/package.json>` | `build-extension-charts.yml` | the `gh-pages` branch, a Helm repository Rancher can add |
| Extension Catalog Image | `libredb-studio-rancher-extension-<version of package.json>` | `build-extension-catalog.yml` | `ghcr.io/libredb/ui-extension-libredb-studio-rancher-extension`, for air-gapped installs |

Both workflows call Rancher's reusable workflows at a pinned commit.
Every published release triggers both, and each job runs only for its own tag prefix, so the other one is skipped; to run one by hand, start it from the release tag ref, not from a branch.

Before the first release, the `gh-pages` branch must exist on GitHub (an orphan branch with no files is enough); the publish script refuses to run without it.

Steps:

1. Bump the version in `pkg/libredb-studio/package.json` (and in `package.json` for a catalog image) in a pull request; versions follow semver and stay 0.x until the partner submission.
2. Before the release, run the end-to-end suite on every declared Rancher line and keep the results.
3. After the pull request merges, publish a GitHub release with the tag above and generated release notes; never write a changelog by hand.
4. Check that the chart appears in `index.yaml` on `gh-pages`, and that Rancher lists the new version after a repository refresh.
