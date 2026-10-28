import { ConfigureVirtualTypeOptions, IPlugin } from '@shell/core/types';
import { TypeMapProduct } from '@shell/types/store/type-map';
import {
  PRODUCT_NAME, CNPG_CLUSTER_TYPE, DATABASES_PAGE, DATABASES_ROUTE, SETTINGS_PAGE, SETTINGS_ROUTE
} from './config';

/** The extension's own store module, which holds the getter the product is gated on */
export const GATE_STORE = 'libredbStudio';
export const PRODUCT_ACTIVE = `${ GATE_STORE }/productActive`;

/** The root getters the gate reads */
interface RootGetters {
  productId: string;
  'cluster/schemaFor'(type: string, fuzzy: boolean, allowThrow: boolean): unknown;
}

/**
 * Whether the product is active. The shell lists an active product in the cluster's navigation, and
 * renders one of its pages only while the route's product is active, so a gate on the CloudNativePG
 * Cluster schema alone left a direct link to any of its pages empty for someone who cannot see that
 * schema, Setup and Settings included. The product is active where the signed-in user can see the
 * schema, and on its own pages wherever they are opened: the Databases page then says what is
 * missing, and Setup and Settings run their own checks.
 */
export const gateStore = {
  namespaced: true,
  getters:    {
    productActive: (_state: unknown, _getters: unknown, _rootState: unknown, rootGetters: RootGetters): boolean => {
      return rootGetters.productId === PRODUCT_NAME || !!rootGetters['cluster/schemaFor'](CNPG_CLUSTER_TYPE, false, false);
    },
  },
  // The shell sends onLogout to every store an extension adds
  actions: { onLogout: (): void => undefined },
};

/**
 * The "LibreDB Studio" product in a cluster's navigation, shown where the signed-in user can see the
 * CloudNativePG Cluster schema; its pages say when that schema or Studio itself is missing.
 */
export function init($plugin: IPlugin, store: unknown): void {
  const { product, virtualType, basicType } = $plugin.DSL(store, PRODUCT_NAME);
  const route = { name: DATABASES_ROUTE, params: { product: PRODUCT_NAME } };

  // The type map reads ifGetter for products, as the 2.15.2 dashboard does, though TypeMapProduct
  // does not declare it
  const options: TypeMapProduct & { ifGetter: string } = {
    inStore:             'cluster',
    ifGetter:            PRODUCT_ACTIVE,
    icon:                'datastore',
    showNamespaceFilter: true,
    to:                  route,
  };

  product(options);

  virtualType({
    name:       DATABASES_PAGE,
    labelKey:   'libredbStudio.databases.label',
    namespaced: true,
    weight:     100,
    route,
  });

  // Settings change and uninstall Studio, which takes the cluster's owner: it is listed to whoever
  // could create the ClusterRole the chart renders, and the page checks ownership itself. The type
  // map reads ifHaveVerb for virtual types, though ConfigureVirtualTypeOptions does not declare it.
  const settings: ConfigureVirtualTypeOptions & { ifHaveVerb: string } = {
    name:       SETTINGS_PAGE,
    labelKey:   'libredbStudio.settings.label',
    namespaced: false,
    weight:     90,
    ifHaveType: 'rbac.authorization.k8s.io.clusterrole',
    ifHaveVerb: 'POST',
    route:      { name: SETTINGS_ROUTE, params: { product: PRODUCT_NAME } },
  };

  virtualType(settings);

  basicType([DATABASES_PAGE, SETTINGS_PAGE]);
}
