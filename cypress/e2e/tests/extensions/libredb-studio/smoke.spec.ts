import pkg from '../../../../../pkg/libredb-studio/package.json';

// Loads the built package into Rancher the way the Extensions page's "Developer Load" does with
// "persist": a UIPlugin with noCache, so the browser fetches the package from the served URL, then
// checks that the dashboard fetches it and loads it without an error. The UIPlugin is removed afterwards.
const UI_PLUGIN_NAMESPACE = 'cattle-ui-plugin-system';
const pluginId = `${ pkg.name }-${ pkg.version }`;

describe('LibreDB Studio extension smoke', { testIsolation: false }, () => {
  const pkgUrl = `${ Cypress.env('libredbPkgUrl') }/${ pluginId }/${ pluginId }.umd.min.js`;

  before(() => {
    cy.login();
    cy.deleteRancherResource('v1', 'catalog.cattle.io.uiplugins', `${ UI_PLUGIN_NAMESPACE }/${ pluginId }`, false);
  });

  after(() => {
    cy.deleteRancherResource('v1', 'catalog.cattle.io.uiplugins', `${ UI_PLUGIN_NAMESPACE }/${ pluginId }`, false);
  });

  it('serves the built package', () => {
    cy.request(pkgUrl).its('status').should('eq', 200);
  });

  it('is loaded by the Rancher dashboard', () => {
    cy.createRancherResource('v1', 'catalog.cattle.io.uiplugins', {
      type:     'catalog.cattle.io.uiplugin',
      metadata: { name: pluginId, namespace: UI_PLUGIN_NAMESPACE },
      spec:     {
        plugin: {
          name:     `${ pkg.name }-developer-load`,
          version:  pkg.version,
          endpoint: pkgUrl,
          noCache:  true,
          noAuth:   true,
          metadata: {
            developer:                                 'true',
            direct:                                    'true',
            'catalog.cattle.io/ui-extensions-version': '>= 3',
          },
        },
      },
    });

    cy.intercept('GET', pkgUrl).as('libredbPkg');
    cy.visit('/home');
    cy.wait('@libredbPkg', { timeout: 30000 }).its('response.statusCode').should('be.oneOf', [200, 304]);

    // A fetched bundle can still fail to load or to initialise; the shell then records an error and
    // never adds the plugin. The plugin carries the package name only once index.ts has run.
    cy.window().its('$globalApp.$store.getters', { timeout: 30000 }).should((getters) => {
      expect(getters['uiplugins/plugins'].map((p: { name: string }) => p.name)).to.include(pkg.name);
      expect(Boolean(getters['uiplugins/errors'][pkg.name]), 'load error').to.equal(false);
    });
  });
});
