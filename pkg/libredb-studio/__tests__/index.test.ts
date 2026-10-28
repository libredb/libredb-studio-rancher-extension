import { ActionLocation, IPlugin, PanelLocation } from '@shell/core/types';
import extension from '../index';
import packageJson from '../package.json';
import * as product from '../product';
import routes from '../routing';
import openInStudioAction from '../actions/open-in-studio';
import { CNPG_CLUSTER_TYPE } from '../config';


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

  it('should add the store module the product is gated on, and remove it again', () => {
    const plugin = mockPlugin();
    const store = { registerModule: jest.fn(), unregisterModule: jest.fn() };

    extension(plugin);

    expect(plugin.addStore).toHaveBeenCalledTimes(1);

    const [name, register, unregister] = (plugin.addStore as jest.Mock).mock.calls[0];

    register()(store);
    unregister(store);

    expect(name).toBe(product.GATE_STORE);
    expect(store.registerModule).toHaveBeenCalledWith(product.GATE_STORE, product.gateStore);
    expect(store.unregisterModule).toHaveBeenCalledWith(product.GATE_STORE);
  });

  it('should add the open action to the row menu of supported databases only', () => {
    const plugin = mockPlugin();

    extension(plugin);

    expect(plugin.addAction).toHaveBeenCalledTimes(1);
    expect(plugin.addAction).toHaveBeenCalledWith(ActionLocation.TABLE, { resource: [CNPG_CLUSTER_TYPE] }, openInStudioAction);
  });

  it('should add the Studio panel to the view page of supported databases only, as its own chunk', async() => {
    const plugin = mockPlugin();

    extension(plugin);

    expect(plugin.addPanel).toHaveBeenCalledTimes(1);

    const [where, when, panel] = (plugin.addPanel as jest.Mock).mock.calls[0];

    expect(where).toBe(PanelLocation.DETAILS_MASTHEAD);
    expect(when).toStrictEqual({ resource: [CNPG_CLUSTER_TYPE], mode: ['detail'] });
    await expect(panel.component()).resolves.toMatchObject({ default: { name: 'StudioPanel' } });
  });
});
