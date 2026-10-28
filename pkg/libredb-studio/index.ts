import { importTypes } from '@rancher/auto-import';
import { ActionLocation, IPlugin } from '@shell/core/types';
import routes from './routing';
import openInStudioAction from './actions/open-in-studio';
import { CNPG_CLUSTER_TYPE } from './config';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // The "LibreDB Studio" product in the cluster's navigation; the shell calls the module's init
  plugin.addProduct(require('./product'));
  plugin.addRoutes(routes);

  // F3: "Open in LibreDB Studio" in a supported database's row menu, shown only when it can open
  plugin.addAction(ActionLocation.TABLE, { resource: [CNPG_CLUSTER_TYPE] }, openInStudioAction);
}
