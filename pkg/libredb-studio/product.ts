import { ConfigureVirtualTypeOptions, IPlugin } from '@shell/core/types';
import {
  PRODUCT_NAME, CNPG_CLUSTER_TYPE, DATABASES_PAGE, DATABASES_ROUTE, SETTINGS_PAGE, SETTINGS_ROUTE
} from './config';

/**
 * The "LibreDB Studio" product in a cluster's navigation. It is shown where the signed-in user can
 * see the CloudNativePG Cluster schema; its pages say when Studio itself is not set up.
 */
export function init($plugin: IPlugin, store: unknown): void {
  const { product, virtualType, basicType } = $plugin.DSL(store, PRODUCT_NAME);
  const route = { name: DATABASES_ROUTE, params: { product: PRODUCT_NAME } };

  product({
    inStore:             'cluster',
    ifHaveType:          CNPG_CLUSTER_TYPE,
    icon:                'datastore',
    showNamespaceFilter: true,
    to:                  route,
  });

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
