import { IPlugin } from '@shell/core/types';
import { getProductFromRoute } from '@shell/utils/router';
import { init } from '../product';
import { PRODUCT_NAME, DATABASES_PAGE, DATABASES_ROUTE, CNPG_CLUSTER_TYPE } from '../config';

describe('product', () => {
  const dsl = () => ({
    product:     jest.fn(),
    virtualType: jest.fn(),
    basicType:   jest.fn(),
  });

  it('registers a cluster product shown only where the CloudNativePG Cluster schema is visible', () => {
    const calls = dsl();
    const plugin = { DSL: jest.fn(() => calls) } as unknown as IPlugin;
    const store = {};

    init(plugin, store);

    expect(plugin.DSL).toHaveBeenCalledWith(store, PRODUCT_NAME);
    expect(calls.product).toHaveBeenCalledWith({
      inStore:             'cluster',
      ifHaveType:          CNPG_CLUSTER_TYPE,
      icon:                'datastore',
      showNamespaceFilter: true,
      to:                  { name: DATABASES_ROUTE, params: { product: PRODUCT_NAME } },
    });
    expect(CNPG_CLUSTER_TYPE).toBe('postgresql.cnpg.io.cluster');
  });

  it('puts the Databases page at the top of the product\'s navigation', () => {
    const calls = dsl();

    init({ DSL: () => calls } as unknown as IPlugin, {});

    expect(calls.virtualType).toHaveBeenCalledWith({
      name:       DATABASES_PAGE,
      labelKey:   'libredbStudio.databases.label',
      namespaced: true,
      weight:     100,
      route:      { name: DATABASES_ROUTE, params: { product: PRODUCT_NAME } },
    });
    expect(calls.basicType).toHaveBeenCalledWith([DATABASES_PAGE]);
  });

  it('uses a product id the shell reads back from the route name', () => {
    expect(PRODUCT_NAME).toBe('libredb');
    expect(DATABASES_ROUTE).toBe('c-cluster-libredb-databases');
    expect(getProductFromRoute({ name: DATABASES_ROUTE, params: {} })).toBe(PRODUCT_NAME);
  });
});
