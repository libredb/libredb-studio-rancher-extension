import { IPlugin } from '@shell/core/types';
import extension from '../index';
import packageJson from '../package.json';
import * as product from '../product';
import routes from '../routing';

// The shell's table pulls in the whole list stack, which the dashboard provides at run time; the
// page's own logic is what these specs cover, and the end-to-end specs cover the real table.
jest.mock('@shell/components/PaginatedResourceTable.vue', () => ({ __esModule: true, default: { name: 'PaginatedResourceTable', render: () => null } }));

/**
 * Stands in for the dashboard's extension manager.
 *
 * Any method your index.ts calls - addProduct, addRoutes, addPanel, addTableColumn, ... - is
 * answered with a jest mock the first time it is read, so this keeps working as you register
 * more things. Assert against them with `expect(plugin.addProduct).toHaveBeenCalledWith(...)`.
 */
const mockPlugin = (): IPlugin => {
  const mocks: Record<string | symbol, unknown> = {};

  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }

      mocks[prop] = mocks[prop] || jest.fn();

      return mocks[prop];
    }
  }) as unknown as IPlugin;
};

describe('extension entry point', () => {
  it('should expose the package.json metadata to the dashboard', () => {
    const plugin = mockPlugin();

    extension(plugin);

    expect(plugin.metadata).toStrictEqual(packageJson);
  });

  it('should add the product and its routes', () => {
    const plugin = mockPlugin();

    extension(plugin);

    expect(plugin.addProduct).toHaveBeenCalledWith(product);
    expect(plugin.addRoutes).toHaveBeenCalledWith(routes);
  });
});
