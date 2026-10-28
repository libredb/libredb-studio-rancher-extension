import routes from '../routing';
import Databases from '../pages/Databases.vue';
import Setup from '../pages/Setup.vue';
import Settings from '../pages/Settings.vue';
import { PRODUCT_NAME, DATABASES_ROUTE, SETUP_ROUTE, SETTINGS_ROUTE } from '../config';
import { getProductFromRoute } from '@shell/utils/router';

// The shell's table pulls in the whole list stack, which the dashboard provides at run time; the
// page's own logic is what these specs cover, and the end-to-end specs cover the real table.
jest.mock('@shell/components/PaginatedResourceTable.vue', () => ({ __esModule: true, default: { name: 'PaginatedResourceTable', render: () => null } }));

describe('routes', () => {
  it('adds the Databases, Setup and Settings pages under the cluster explorer\'s default layout', () => {
    expect(routes.map(({ parent }) => parent)).toStrictEqual(['default', 'default', 'default']);
    expect(routes.map(({ route }) => ({
      name: route.name, path: route.path, meta: route.meta
    }))).toStrictEqual([
      {
        name: DATABASES_ROUTE, path: '/c/:cluster/libredb/databases', meta: { product: PRODUCT_NAME }
      },
      {
        name: SETUP_ROUTE, path: '/c/:cluster/libredb/setup', meta: { product: PRODUCT_NAME }
      },
      {
        name: SETTINGS_ROUTE, path: '/c/:cluster/libredb/settings', meta: { product: PRODUCT_NAME }
      },
    ]);
  });

  it('names every page so the shell reads the product back from the route', () => {
    expect(SETUP_ROUTE).toBe('c-cluster-libredb-setup');
    routes.forEach(({ route }) => expect(getProductFromRoute({ name: route.name, params: {} })).toBe(PRODUCT_NAME));
  });

  it('loads each page as its own chunk on the first visit', async() => {
    const [databases, setup, settings] = routes;

    await expect(databases.route.component()).resolves.toMatchObject({ default: Databases });
    await expect(setup.route.component()).resolves.toMatchObject({ default: Setup });
    await expect(settings.route.component()).resolves.toMatchObject({ default: Settings });
  });
});
