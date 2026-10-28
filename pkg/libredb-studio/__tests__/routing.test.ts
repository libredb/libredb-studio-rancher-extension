import routes from '../routing';
import Databases from '../pages/Databases.vue';
import { PRODUCT_NAME, DATABASES_ROUTE } from '../config';

// The shell's table pulls in the whole list stack, which the dashboard provides at run time; the
// page's own logic is what these specs cover, and the end-to-end specs cover the real table.
jest.mock('@shell/components/PaginatedResourceTable.vue', () => ({ __esModule: true, default: { name: 'PaginatedResourceTable', render: () => null } }));

describe('routes', () => {
  it('adds the Databases page under the cluster explorer\'s default layout', () => {
    expect(routes).toStrictEqual([{
      parent: 'default',
      route:  {
        name:      DATABASES_ROUTE,
        path:      '/c/:cluster/libredb/databases',
        component: Databases,
        meta:      { product: PRODUCT_NAME },
      },
    }]);
  });
});
