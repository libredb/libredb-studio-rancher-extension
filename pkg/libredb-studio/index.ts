import { importTypes } from '@rancher/auto-import';
import { ActionLocation, IPlugin, PanelLocation } from '@shell/core/types';
import routes from './routing';
import openInStudioAction from './actions/open-in-studio';
import { CNPG_CLUSTER_TYPE } from './config';
import { GATE_STORE, gateStore } from './product';

/** The part of the dashboard's Vuex store that an extension's store module is added to */
interface ModuleHost {
  registerModule(name: string, module: typeof gateStore): void;
  unregisterModule(name: string): void;
}

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // The "LibreDB Studio" product in the cluster's navigation; the shell calls the module's init. It
  // is gated on a getter of the extension's own store module.
  plugin.addStore(GATE_STORE, () => (store: ModuleHost) => store.registerModule(GATE_STORE, gateStore), (store: ModuleHost) => store.unregisterModule(GATE_STORE));
  plugin.addProduct(require('./product'));
  plugin.addRoutes(routes);

  // F3: "Open in LibreDB Studio" in a supported database's row menu, shown only when it can open
  plugin.addAction(ActionLocation.TABLE, { resource: [CNPG_CLUSTER_TYPE] }, openInStudioAction);

  // F4: Studio's panel in a supported database's title bar. A CloudNativePG Cluster has no detail
  // view of its own, so detail-page tabs never render there and the masthead is the place. The
  // masthead also renders on the create, clone and edit pages, so the panel is bound to the view page.
  plugin.addPanel(PanelLocation.DETAILS_MASTHEAD, { resource: [CNPG_CLUSTER_TYPE], mode: ['detail'] }, { component: () => import(/* webpackChunkName: "studio-panel" */ './components/StudioPanel.vue') });
}
