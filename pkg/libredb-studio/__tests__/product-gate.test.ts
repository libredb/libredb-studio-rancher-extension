import { createStore, Store } from 'vuex';
import { IPlugin } from '@shell/core/types';
import { DSL, state as typeMapState, getters as typeMapGetters, mutations as typeMapMutations } from '@shell/store/type-map';
import { getProductFromRoute } from '@shell/utils/router';
import extension from '../index';
import {
  CNPG_CLUSTER_TYPE, DATABASES_ROUTE, PRODUCT_NAME, SETTINGS_ROUTE, SETUP_ROUTE
} from '../config';

type Schemas = string[] | 'not loaded';

/**
 * The shell's own product gate, fed by everything the extension registers. The dashboard sets the
 * product from the route, then renders the route's page only while that product is active: the
 * default layout compares currentProduct, picked from type-map/activeProducts, with the route's
 * product, and leaves the main area empty when they differ. The navigation lists the active products.
 */
function dashboard(schemas: Schemas) {
  const store: Store<{ productId: string }> = createStore({
    state:     { productId: 'explorer' },
    getters:   { productId: (state: { productId: string }) => state.productId },
    mutations: {
      setProduct: (state: { productId: string }, product: string) => {
        state.productId = product;
      }
    },
    modules: {
      'type-map': {
        namespaced: true,
        state:      typeMapState,
        getters:    typeMapGetters as never,
        mutations:  typeMapMutations as never,
      },
      cluster: {
        namespaced: true,
        getters:    {
          all:       () => (type: string) => (type === 'schema' && schemas !== 'not loaded' ? schemas.map((id) => ({ id, _id: id })) : []),
          // As the steve store's schemaFor: null while the schemas are not loaded, unless asked to throw
          schemaFor: () => (id: string, _fuzzy = false, allowThrow = true) => {
            if (schemas === 'not loaded') {
              if (allowThrow) {
                throw new Error('Schemas aren\'t loaded yet');
              }

              return null;
            }

            return schemas.includes(id) ? { id } : undefined;
          },
        },
      },
      prefs:    { namespaced: true, getters: { get: () => () => false } },
      features: { namespaced: true, getters: { get: () => () => true } },
    },
  });

  const registered: Record<string | symbol, unknown> = {
    DSL:        (target: unknown, name: string) => DSL(target, name),
    addProduct: (module: { init: (plugin: IPlugin, target: unknown) => void }) => module.init(plugin, store),
    addStore:   (_name: string, register: () => (target: unknown) => void) => register()(store),
  };
  const plugin = new Proxy(registered, { get: (target, prop) => (prop in target ? target[prop] : () => undefined) }) as unknown as IPlugin;

  extension(plugin);

  return {
    store,
    open(route: string): void {
      store.commit('setProduct', getProductFromRoute({ name: route, params: {} } as never));
    },
    activeProducts: (): string[] => store.getters['type-map/activeProducts'].map((product: { name: string }) => product.name),
  };
}

describe('the product in the dashboard', () => {
  it.each([DATABASES_ROUTE, SETUP_ROUTE, SETTINGS_ROUTE])('renders %s on a direct link where the user cannot see the CloudNativePG Cluster schema', (route) => {
    const shell = dashboard(['namespace']);

    shell.open(route);

    expect(shell.store.getters.productId).toBe(PRODUCT_NAME);
    expect(shell.activeProducts()).toContain(PRODUCT_NAME);
  });

  it('stays out of the navigation elsewhere where the user cannot see the schema', () => {
    const shell = dashboard(['namespace']);

    shell.open('c-cluster-explorer');

    expect(shell.activeProducts()).not.toContain(PRODUCT_NAME);
  });

  it('is in the navigation wherever the user can see the schema', () => {
    const shell = dashboard(['namespace', CNPG_CLUSTER_TYPE]);

    shell.open('c-cluster-explorer');

    expect(shell.activeProducts()).toContain(PRODUCT_NAME);
  });

  it('stays out of the navigation before a cluster\'s schemas are loaded, without failing', () => {
    const shell = dashboard('not loaded');

    shell.open('home');

    expect(shell.activeProducts()).not.toContain(PRODUCT_NAME);
  });

  it('answers the shell\'s logout, which every store an extension adds is sent', async() => {
    const shell = dashboard(['namespace']);

    await expect(shell.store.dispatch('libredbStudio/onLogout')).resolves.toBeUndefined();
  });
});
