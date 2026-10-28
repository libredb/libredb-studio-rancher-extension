# LibreDB Studio

Open the databases of a Rancher cluster in LibreDB Studio, a web SQL IDE, with each user's own Kubernetes permissions.

Status: in development, not yet listed in any extension catalog, and not ready for production use.

The extension adds a LibreDB Studio product to the cluster explorer of every cluster where the signed-in user can see CloudNativePG Clusters.
Its Databases page shows whether LibreDB Studio is set up and running in the cluster, and lists the CloudNativePG Clusters with an Open button for each one the user may open, or the reason a row cannot be opened and who can fix it.
The row menu of a CloudNativePG Cluster has "Open in LibreDB Studio" when the user may open it, and its view page shows the host, database and user, never a password, with the same Open button or the reason.

A cluster owner sets LibreDB Studio up from the Databases page.
The setup checks the cluster first, then installs the LibreDB Studio partner chart from Rancher's Partners repository in its own namespace, outside every project, with the host name, certificate and namespaces to discover that the cluster owner chose.
With a Rancher administrator, it also registers LibreDB Studio as an OIDC client of Rancher, so people sign in with their Rancher account and open only the databases their own Rancher roles let them read; without one, LibreDB Studio keeps its own sign-in, and an administrator can turn single sign-on on later.
Single sign-on is experimental: owners of the cluster that runs LibreDB Studio will be able to act in Rancher as any user who signs in to LibreDB Studio, so the administrator acknowledges that before it is turned on, and it belongs only on clusters whose owners are trusted that far.
The Settings page changes the namespaces LibreDB Studio discovers, turns single sign-on on, and uninstalls LibreDB Studio after the release name is typed by hand.
Once single sign-on is on, a Rancher administrator can rotate its client secret there, which restarts LibreDB Studio with the new one, and can turn single sign-on off again after typing the OIDC client's name, which upgrades LibreDB Studio back to its own sign-in and deletes the OIDC client.

It has no backend of its own: it works through Rancher's API as the signed-in user, never reads a database's Secret, and opens LibreDB Studio, installed in the same cluster, in a new tab.
The only Secret value it reads is the OIDC client secret Rancher generates, once each time an administrator sets up single sign-on or rotates the secret, and it writes that secret straight into LibreDB Studio's own Secret without showing it.
When it replaces or removes that Secret, on a rotation, when single sign-on is turned off, on an uninstall or after a failed setup, it reads the Secret's labels alone.

- Supported Rancher versions: 2.15 and later.
- Rancher mode needs a LibreDB Studio chart and release that carry it: chart 0.1.107 or later, with LibreDB Studio after 1.1.0.
- Source, issues and security policy: https://github.com/libredb/libredb-studio-rancher-extension
- LibreDB Studio: https://github.com/libredb/libredb-studio

MIT licensed.
