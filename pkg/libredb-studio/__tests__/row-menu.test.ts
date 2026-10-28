import { ActionLocation, ExtensionPoint, IPlugin } from '@shell/core/types';
import { Plugin } from '@shell/core/plugin';
import { getApplicableExtensionEnhancements } from '@shell/core/plugin-helpers';
import extension from '../index';
import openInStudioAction from '../actions/open-in-studio';
import { CNPG_CLUSTER_TYPE, DATABASES_ROUTE, PRODUCT_NAME } from '../config';

interface RowAction {
  labelKey?: string;
}

/**
 * The extension actions a row menu offers on a route. A resource's row menu takes the table actions
 * whose location matches the current route, through the shell's getApplicableExtensionEnhancements,
 * so this runs the shell's own matching over everything the extension registers with the shell's
 * own Plugin.
 */
function rowMenu(name: string, params: Record<string, string>): RowAction[] {
  const plugin = new Plugin('libredb-studio-0.1.0');

  extension(plugin as unknown as IPlugin);

  const shell = {
    $extension: {
      getUIConfig:    (type: string, area: string) => plugin.uiConfig[type]?.[area] || [],
      getAllUIConfig: () => plugin.uiConfig,
    },
    t: (key: string) => key,
  };
  const route = {
    name, params, query: {}, meta: {}, hash: '', path: '/'
  };

  return getApplicableExtensionEnhancements<RowAction>(shell, ExtensionPoint.ACTION, ActionLocation.TABLE, route as never);
}

const opens = (actions: RowAction[]) => actions.filter((action) => action.labelKey === openInStudioAction.labelKey);

describe('the row menu', () => {
  it('offers Open in LibreDB Studio on the extension\'s Databases page, whose route names no resource', () => {
    expect(opens(rowMenu(DATABASES_ROUTE, { cluster: 'c-1' }))).toHaveLength(1);
  });

  it('offers it once on Rancher\'s list of CloudNativePG Clusters', () => {
    expect(opens(rowMenu('c-cluster-product-resource', {
      cluster: 'c-1', product: 'explorer', resource: CNPG_CLUSTER_TYPE
    }))).toHaveLength(1);
  });

  it('offers it on no other list', () => {
    expect(opens(rowMenu('c-cluster-product-resource', {
      cluster: 'c-1', product: 'explorer', resource: 'apps.deployment'
    }))).toStrictEqual([]);
    expect(PRODUCT_NAME).toBe('libredb');
  });
});
