import ExtensionsPagePo from '@rancher/cypress/e2e/po/pages/extensions.po';
import { catchTargetPageException } from '@rancher/cypress/support/utils/exception-utils';
import { LONG_TIMEOUT_OPT } from '@rancher/cypress/support/utils/timeouts';
import pkg from '../../../../../pkg/libredb-studio/package.json';

// Installs the extension as a Rancher administrator does: from the Extensions page, through a Helm
// repository holding the chart the shell's publish script builds (scripts/e2e/chart-repo.sh). The page
// offers a version for install only when the shell's checks pass the chart's catalog annotations,
// which the smoke spec's Developer Load never runs. Rancher serves each chart's icon itself, fetched
// from the chart's icon URL, which in this repository is this checkout's icon file.
const UI_PLUGIN_NAMESPACE = 'cattle-ui-plugin-system';
const RELEASE = `${ UI_PLUGIN_NAMESPACE }/${ pkg.name }`;
const REPO_NAME = 'libredb-studio-e2e';
const TITLE = pkg.rancher.annotations['catalog.cattle.io/display-name'];
const ICON_FILE = 'pkg/libredb-studio/assets/icon.svg';
const CARD_IMAGE = '[data-testid="item-card-image"] img';
// Without it Rancher's API answers a browser's request with its HTML API browser
const JSON_ONLY = { Accept: 'application/json' };

/**
 * Uninstalls the release this spec installed, also one an earlier run left, and removes its
 * repository. An install from another repository is not this spec's to remove, so the spec stops.
 */
function removeOwnInstall(): void {
  cy.request({
    url: `${ Cypress.env('api') }/v1/catalog.cattle.io.apps/${ RELEASE }`, headers: JSON_ONLY, failOnStatusCode: false
  }).then((resp) => {
    if (resp.status === 404) {
      return;
    }

    expect(resp.status, `reading ${ RELEASE }`).to.equal(200);
    expect(resp.body.metadata?.labels?.['catalog.cattle.io/cluster-repo-name'], `${ RELEASE } comes from another repository; uninstall it before this spec runs`).to.equal(REPO_NAME);
    cy.createRancherResource('v1', `catalog.cattle.io.apps/${ RELEASE }?action=uninstall`, {});
    cy.waitForRancherResource('v1', 'catalog.cattle.io.apps', RELEASE, (app) => app.status === 404, 40, { failOnStatusCode: false });
    cy.waitForRancherResource('v1', 'catalog.cattle.io.uiplugins', RELEASE, (plugin) => plugin.status === 404, 40, { failOnStatusCode: false });
  });
  cy.deleteRancherResource('v1', 'catalog.cattle.io.clusterrepos', REPO_NAME, false);
}

/** The image shows this chart's icon, which Rancher serves from the chart's icon URL, and it loaded */
function rendersChartIcon(image: Cypress.Chainable): Cypress.Chainable<string> {
  return image.should((found) => {
    const img = found[0] as HTMLImageElement;
    const src = new URL(img.src);

    expect(src.searchParams.get('link'), 'an icon Rancher serves').to.equal('icon');
    expect(src.searchParams.get('chartName')).to.equal(pkg.name);
    expect(img.complete && img.naturalWidth, 'icon loaded').to.be.greaterThan(0);
  }).then((found) => (found[0] as HTMLImageElement).src);
}

describe('LibreDB Studio from the Extensions page', { testIsolation: false }, () => {
  const repoUrl: string = Cypress.env('libredbChartRepoUrl');
  const extensionsPage = new ExtensionsPagePo();

  before(function() {
    if (!repoUrl) {
      cy.log('LIBREDB_CHART_REPO_URL is not set, so the extension is not installed from a Helm repository');
      this.skip();
    }

    cy.login();
    removeOwnInstall();
    cy.createRancherResource('v1', 'catalog.cattle.io.clusterrepos', {
      type:     'catalog.cattle.io.clusterrepo',
      metadata: { name: REPO_NAME },
      spec:     { url: repoUrl },
    });
    cy.waitForRepositoryDownload('v1', 'catalog.cattle.io.clusterrepos', REPO_NAME, 40);
  });

  beforeEach(() => {
    catchTargetPageException(['Failed call', 'Network Error']);
  });

  after(() => {
    if (repoUrl) {
      removeOwnInstall();
    }
  });

  it('shows the chart with its icon, in the card and in its details', () => {
    ExtensionsPagePo.goTo();
    extensionsPage.extensionTabAvailableClick();
    extensionsPage.waitForPage(null, 'available');
    extensionsPage.loading().should('not.exist');

    rendersChartIcon(extensionsPage.extensionCard(TITLE, LONG_TIMEOUT_OPT).self().find(CARD_IMAGE)).then((src) => {
      cy.readFile(ICON_FILE).then((svg) => {
        cy.request(src).its('body').should('equal', svg);
      });
    });

    extensionsPage.extensionCardClick(TITLE);
    extensionsPage.extensionDetailsTitle().should('contain', TITLE);
    rendersChartIcon(extensionsPage.extensionDetails().find('.plugin-icon img'));
    extensionsPage.extensionDetailsCloseClick();
  });

  it('offers Install, which the page withholds from a version its checks refuse, and installs it', () => {
    extensionsPage.installExtensionFromCatalog(TITLE, REPO_NAME, 'installLibredbStudio');
  });

  it('loads the installed extension, which keeps its icon on the Installed tab', () => {
    // Rancher fetched the plugin from the chart's endpoint and serves it from its cache
    cy.waitForRancherResource('v1', 'catalog.cattle.io.uiplugins', RELEASE, (resp) => {
      return resp.status === 200 && resp.body.status?.cacheState === 'cached' && resp.body.status?.ready === true;
    }, 40, { failOnStatusCode: false });

    // A loaded bundle that failed to initialise is recorded as an error and never added as a plugin
    cy.window().its('$globalApp.$store.getters', LONG_TIMEOUT_OPT).should((getters) => {
      expect(getters['uiplugins/plugins'].map((p: { name: string }) => p.name)).to.include(pkg.name);
      expect(Boolean(getters['uiplugins/errors'][pkg.name]), 'load error').to.equal(false);
    });

    extensionsPage.extensionTabInstalledClick();
    extensionsPage.waitForPage(null, 'installed');
    rendersChartIcon(extensionsPage.extensionCard(TITLE, LONG_TIMEOUT_OPT).self().find(CARD_IMAGE));
  });
});
