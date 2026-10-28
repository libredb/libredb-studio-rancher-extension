/**
 * Version rules of the setup wizard: which Rancher line it runs on, which scopes that line's OIDC
 * provider accepts, and which Studio chart versions have Rancher mode.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface RancherLine {
  major: number;
  minor: number;
}

export interface ChartVersion {
  version: string;
  appVersion?: string;
}

/** The first chart with the access review and Kubernetes discovery values */
export const MIN_CHART_VERSION = '0.1.107';
/** The first application after 1.1.0, which has neither the access review nor Kubernetes discovery */
export const MIN_APP_VERSION = '1.1.1';

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string | undefined): Version | undefined {
  const match = VERSION.exec(text || '');

  return match ? {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : []
  } : undefined;
}

const NUMERIC = /^\d+$/;

/** Semantic version precedence of two prerelease identifiers */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);

  if (aNumeric && bNumeric) {
    return Number(a) - Number(b);
  }

  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }

  return a < b ? -1 : Number(a > b);
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length || !b.length) {
    // A release comes after each of its prereleases
    return b.length - a.length;
  }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifiers(a[i], b[i]);

    if (order) {
      return order;
    }
  }

  return a.length - b.length;
}

/** Semantic version precedence; build metadata does not count */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (!left || !right) {
    throw new Error(`Not a version: ${ left ? b : a }`);
  }

  return (left.major - right.major) || (left.minor - right.minor) || (left.patch - right.patch) || comparePrerelease(left.prerelease, right.prerelease);
}

/** The line of a server-version setting such as v2.15.2 or v2.15-head; nothing for a dev build */
export function rancherLine(serverVersion: string | undefined): RancherLine | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(serverVersion || '');

  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

/**
 * The scopes Studio's OIDC client asks for: groups from 2.15, where Rancher sends the groups claim
 * only for that scope; openid and profile before, since 2.12 and 2.13 refuse any other scope. An
 * unknown build counts as a current line, because the extension declares 2.15 as its floor.
 */
export function oidcScopes(line: RancherLine | undefined): string[] {
  const current = !line || line.major > 2 || (line.major === 2 && line.minor >= 15);

  return current ? ['openid', 'profile', 'groups'] : ['openid', 'profile'];
}

/** Every scope list a Rancher line registers Studio's client with, as the setup record keeps it */
export const OIDC_SCOPE_LISTS: string[] = [oidcScopes(undefined), oidcScopes({ major: 2, minor: 14 })].map((scopes) => scopes.join(' '));

/**
 * The newest released chart version in a repository index with Rancher mode and an application
 * that runs it, and the newest released version whatever it holds, for saying what is missing.
 */
export function pickChartVersion(entries: ChartVersion[] | undefined): { chosen?: ChartVersion, newest?: ChartVersion } {
  const released = (entries || [])
    .filter((entry) => parseVersion(entry.version)?.prerelease.length === 0)
    .map(({ version, appVersion }) => ({ version, appVersion }))
    .sort((a, b) => compareVersions(b.version, a.version));
  const chosen = released.find(({ version, appVersion }) => compareVersions(version, MIN_CHART_VERSION) >= 0 &&
    !!parseVersion(appVersion) && compareVersions(appVersion as string, MIN_APP_VERSION) >= 0);

  return { chosen, newest: released[0] };
}
