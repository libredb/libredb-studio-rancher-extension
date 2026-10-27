# LibreDB Studio

Open the databases of a Rancher cluster in LibreDB Studio, a web SQL IDE, with each user's own Kubernetes permissions.

This extension adds a LibreDB Studio product to the cluster explorer of clusters that run supported databases.
It has no backend of its own: it reads through Rancher's API as the signed-in user and opens LibreDB Studio, installed in the same cluster, in a new tab.

- Supported Rancher versions: 2.15 and later.
- Source, issues and security policy: https://github.com/libredb/libredb-studio-rancher-extension
- LibreDB Studio: https://github.com/libredb/libredb-studio

MIT licensed.
