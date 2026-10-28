import type { StoreLike } from './types';

export const NAVLINK_TYPE = 'ui.cattle.io.navlink';

/** Studio's chart labels its NavLink so, whatever the release is called */
export const NAVLINK_LABEL_SELECTOR = { matchLabels: { 'app.kubernetes.io/name': 'libredb-studio' } };

export interface NavLinkLike {
  metadata: { name: string };
  spec?: { toURL?: string };
}

export interface StudioLink {
  name: string;
  toURL: string;
  /** Studio's namespace: the chart names the NavLink <namespace>.<fullname> */
  namespace: string;
  /** The chart's fullname, which is also the Studio Deployment's name */
  deploymentName: string;
}

/**
 * The link's URL when it is https, the only scheme the extension opens, and has no query or
 * fragment, which the Studio link appends its own path and query to.
 */
export function usableToURL(navlink: NavLinkLike): string | undefined {
  const toURL = navlink.spec?.toURL;

  if (!toURL) {
    return undefined;
  }

  try {
    const url = new URL(toURL);

    return url.protocol === 'https:' && !url.search && !url.hash ? toURL : undefined;
  } catch {
    return undefined;
  }
}

function toStudioLink(navlink: NavLinkLike): StudioLink | undefined {
  const toURL = usableToURL(navlink);
  const name = navlink.metadata.name;
  const dot = name.indexOf('.');

  if (!toURL || dot < 1) {
    return undefined;
  }

  return {
    name, toURL, namespace: name.slice(0, dot), deploymentName: name.slice(dot + 1)
  };
}

/** The first usable link by name, and how many usable links the cluster has */
export function selectStudioLink(navlinks: NavLinkLike[]): { found: number, link?: StudioLink } {
  const usable = navlinks
    .map(toStudioLink)
    .filter((link): link is StudioLink => !!link)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { found: usable.length, link: usable[0] };
}

/** Studio's NavLinks in the current cluster, read as the signed-in user */
export async function findStudioLinks(store: StoreLike): Promise<NavLinkLike[]> {
  if (!store.getters['cluster/schemaFor'](NAVLINK_TYPE)) {
    return [];
  }

  try {
    return await store.dispatch('cluster/findLabelSelector', {
      type:     NAVLINK_TYPE,
      matching: { labelSelector: NAVLINK_LABEL_SELECTOR },
    }) as NavLinkLike[];
  } catch {
    return [];
  }
}
