# LibreDB Studio

Open the databases of a Rancher cluster in LibreDB Studio, a web SQL IDE, with each user's own Kubernetes permissions.

Status: in development, not yet listed in any extension catalog, and not ready for production use.

The extension adds a LibreDB Studio product to the cluster explorer of every cluster where the signed-in user can see CloudNativePG Clusters.
Its Databases page shows whether LibreDB Studio is set up and running in the cluster, and lists the CloudNativePG Clusters with an Open button for each one the user may open, or the reason a row cannot be opened and who can fix it.
It has no backend of its own: it reads through Rancher's API as the signed-in user, never reads a Secret, and opens LibreDB Studio, installed in the same cluster, in a new tab.

- Supported Rancher versions: 2.15 and later.
- Source, issues and security policy: https://github.com/libredb/libredb-studio-rancher-extension
- LibreDB Studio: https://github.com/libredb/libredb-studio

MIT licensed.
