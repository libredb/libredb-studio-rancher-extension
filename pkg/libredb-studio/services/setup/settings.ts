import { findStudioLinks, selectStudioLink, StudioLink } from '../navlink';
import { studioStatus, StudioStatus } from '../studio-status';
import type { StoreLike } from '../types';
import {
  removeNamespace, removeNavLink, removeOidcClient, removeOidcSecret, removeRancherCA, removeRecord, removeRelease, undoCreated, UndoEvent, UndoId
} from './cleanup';
import { Failure, failureOf, StepFailure } from './failure';
import { isHostName, namespacesError } from './form';
import { canI, findAllIfVisible, kubeGet, LOCAL_CLUSTER } from './k8s';
import {
  CHART_NAME, CHART_REPO, PROJECT_ANNOTATION, RANCHER_CA_CONFIGMAP, RANCHER_CA_KEY, RELEASE_NAME, STUDIO_NAMESPACE, oidcClientName
} from './names';
import { copyClientSecret, createOidcClient, waitForClientId } from './oidc-client';
import {
  aggregationCheck, rancherContext, ssoChecks, Check, RancherContext
} from './preflight';
import { createConfigMap, readRecord, replaceRecord } from './record';
import { releaseState, upgradeRelease, waitForRelease } from './release';
import { runSteps, StepEvent } from './steps';
import {
  oidcIssuer, sameRecord, SetupRecord, SsoRecord
} from './values';
import { OIDC_SCOPE_LISTS } from './versions';
import type { WaitOptions } from './wait';

/**
 * F7, Studio's settings (design sections 6.2 and 6.4): the discovered namespaces, single sign-on
 * and uninstall, for a Studio the setup wizard installed. Rancher keeps no values on the app, so
 * every change rebuilds them from the wizard's record, and the record follows only after Studio
 * took the change.
 */

/** What the settings page knows of the app */
export interface AppInfo {
  chartVersion?: string;
  appVersion?: string;
  status?: string;
  revision: number;
  /** Whether it carries the extension's mark, which uninstall needs and an upgrade puts back */
  managed: boolean;
}

export interface StudioSettings {
  /** Whether the user owns the cluster; nothing else is read for anyone else */
  canChange: boolean;
  record?: SetupRecord;
  /** The record is there but is not one this version wrote */
  recordUnreadable: boolean;
  /** What makes the record untrustworthy here, so that no action follows it */
  recordProblem?: string;
  /** The host Studio's Ingress serves, the only host a change or a redirect takes */
  host?: string;
  app?: AppInfo;
  link?: StudioLink;
  status?: StudioStatus;
  aggregation?: Check;
  /** The namespaces discovery may cover */
  namespaces: string[];
  /** Studio's namespace was moved into a project, whose members can then read its Secrets */
  inProject?: boolean;
  /** For a Studio without single sign-on: whether it can be turned on here, and with what */
  sso?: { checks: Check[], canUseSso: boolean, context: RancherContext };
}

export type ChangeStepId = 'oidcClient' | 'oidcSecret' | 'rancherCA' | 'upgrade' | 'saveRecord';

export interface ChangeOptions extends WaitOptions {
  onStep?: (event: StepEvent<ChangeStepId>) => void;
  onUndo?: (event: UndoEvent) => void;
}

export interface ChangeResult {
  ok: boolean;
  failedStep?: ChangeStepId;
  failure?: Failure;
  undone: UndoEvent[];
  /** The record as it now stands, after a change that went through */
  record?: SetupRecord;
}

/**
 * Why a record must not steer an action, or nothing. Anyone who can edit Studio's namespace can edit
 * the record, so an administrator's action on it stays on this cluster, on the release the
 * extension installs, on the OIDC client it would create here, and on the scopes a Rancher line
 * registers that client with.
 */
export function recordProblem(record: SetupRecord, cluster: string): string | undefined {
  if (record.cluster !== cluster) {
    return 'cluster';
  }

  const { release } = record;

  if (release.namespace !== STUDIO_NAMESPACE || release.name !== RELEASE_NAME || release.chart !== CHART_NAME) {
    return 'release';
  }

  // Charts come only from the extension's own repository
  if (release.repo !== CHART_REPO) {
    return 'repo';
  }

  if (!record.sso) {
    return undefined;
  }

  if (record.sso.client !== oidcClientName(cluster)) {
    return 'client';
  }

  return OIDC_SCOPE_LISTS.includes(record.sso.scope) ? undefined : 'scope';
}

/** The host Studio's Ingress serves, when it is a bare host name; never the record's */
export async function deployedHost(store: StoreLike, cluster: string): Promise<string | undefined> {
  try {
    const ingress = await kubeGet<{ spec?: { rules?: { host?: string }[] } }>(store, cluster,
      `/apis/networking.k8s.io/v1/namespaces/${ STUDIO_NAMESPACE }/ingresses/${ RELEASE_NAME }`);
    const host = ingress?.spec?.rules?.[0]?.host || '';

    return isHostName(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Studio's namespace was moved into a project, whose members could then read its Secrets */
async function namespaceInProject(store: StoreLike, cluster: string): Promise<boolean> {
  const namespace = await kubeGet<{ metadata?: { annotations?: Record<string, string> } }>(store, cluster, `/api/v1/namespaces/${ STUDIO_NAMESPACE }`);

  return !!namespace?.metadata?.annotations?.[PROJECT_ANNOTATION];
}

/** The namespaces discovery may cover, as the acting user sees them now */
async function visibleNamespaces(store: StoreLike): Promise<string[]> {
  const namespaces = await findAllIfVisible<{ metadata: { name: string } }>(store, 'namespace');

  return namespaces.map((item) => item.metadata.name).filter((name) => name !== STUDIO_NAMESPACE).sort((a, b) => a.localeCompare(b));
}

function refused(reason: string, args?: Record<string, string>): ChangeResult {
  return {
    ok: false, failure: args ? { reason, args } : { reason }, undone: []
  };
}

export async function loadSettings(store: StoreLike, cluster: string): Promise<StudioSettings> {
  if (!await canI(store, cluster, {
    verb: '*', group: '*', resource: '*'
  })) {
    return {
      canChange: false, recordUnreadable: false, namespaces: []
    };
  }

  const { exists, record } = await readRecord(store, cluster);
  const problem = record && recordProblem(record, cluster);
  const state = await releaseState(store, cluster, STUDIO_NAMESPACE, RELEASE_NAME);
  const { link } = selectStudioLink(await findStudioLinks(store));
  let sso: StudioSettings['sso'];

  if (record && !record.sso && !problem) {
    const context = await rancherContext(store);

    sso = { ...await ssoChecks(store, cluster, context.serverUrl), context };
  }

  return {
    canChange:        true,
    record,
    recordUnreadable: exists && !record,
    recordProblem:    problem,
    host:             await deployedHost(store, cluster),
    app:              state && {
      chartVersion: state.chartVersion, appVersion: state.appVersion, status: state.status, revision: state.revision, managed: state.managed
    },
    link,
    status:      await studioStatus(store, link),
    aggregation: await aggregationCheck(store),
    namespaces:  await visibleNamespaces(store),
    inProject:   await namespaceInProject(store, cluster),
    sso,
  };
}

/**
 * The version of the record when it is still the one the page showed, or nothing when it changed or
 * went since: a change acts only on what the person saw, never over what someone did after.
 */
async function unchangedRecord(store: StoreLike, cluster: string, shown: SetupRecord): Promise<{ resourceVersion?: string } | undefined> {
  const live = await readRecord(store, cluster);

  return live.record && sameRecord(live.record, shown) ? { resourceVersion: live.resourceVersion } : undefined;
}

/** Whether the app is still at the revision the page showed */
async function unchangedApp(store: StoreLike, cluster: string, app: AppInfo): Promise<boolean> {
  const state = await releaseState(store, cluster, STUDIO_NAMESPACE, RELEASE_NAME);

  return state?.revision === app.revision;
}

/**
 * Upgrades Studio to the changed record at the chart version deployed now, and waits for the
 * revision this upgrade makes: the revision is read right before the upgrade starts, so one someone
 * else made earlier never counts as this one.
 */
async function upgradeTo(store: StoreLike, cluster: string, record: SetupRecord, options: WaitOptions): Promise<void> {
  const before = await releaseState(store, cluster, STUDIO_NAMESPACE, RELEASE_NAME);

  if (!before) {
    throw new StepFailure('changedSinceLoad');
  }

  const operation = await upgradeRelease(store, cluster, record, before.chartVersion || record.release.chartVersion);

  await waitForRelease(store, cluster, record, operation, before.revision, options);
}

/** Changes the namespaces Studio discovers */
export async function saveNamespaces(store: StoreLike, cluster: string, record: SetupRecord, app: AppInfo, namespaces: string[], options: ChangeOptions = {}): Promise<ChangeResult> {
  const problem = recordProblem(record, cluster);

  if (problem) {
    return refused('untrustedRecord', { field: problem });
  }

  const live = await unchangedRecord(store, cluster, record);

  if (!live || !await unchangedApp(store, cluster, app)) {
    return refused('changedSinceLoad');
  }

  if (await namespaceInProject(store, cluster)) {
    return refused('inProject', { namespace: STUDIO_NAMESPACE });
  }

  // Revalidated against what the user sees now, never taken on trust
  if (namespacesError(namespaces, await visibleNamespaces(store))) {
    return refused('badNamespaces');
  }

  const host = await deployedHost(store, cluster);

  if (!host) {
    return refused('noHost');
  }

  const changed: SetupRecord = {
    ...record, host, namespaces: [...new Set(namespaces)].sort((a, b) => a.localeCompare(b))
  };

  // Studio trusts the issuer for every sign-in, so it is Rancher's own, never the record's
  if (changed.sso) {
    const { serverUrl } = await rancherContext(store);

    if (!serverUrl) {
      return refused('ssoUnavailable');
    }

    changed.sso = { ...changed.sso, issuer: oidcIssuer(serverUrl) };
  }
  const failed = await runSteps<ChangeStepId>(['upgrade', 'saveRecord'], {
    upgrade: async() => {
      await upgradeTo(store, cluster, changed, options);

      return 'done';
    },
    saveRecord: async() => {
      await replaceRecord(store, cluster, changed, live.resourceVersion);

      return 'done';
    },
  } as Record<ChangeStepId, () => Promise<'done'>>, options.onStep);

  return failed ? {
    ok: false, failedStep: failed.step, failure: failed.failure, undone: []
  } : {
    ok: true, undone: [], record: changed
  };
}

/**
 * Puts Studio back on the record it had after an upgrade to single sign-on failed, then removes what
 * the attempt created; while Studio may still run on the new values, those are kept instead.
 */
async function compensate(store: StoreLike, cluster: string, record: SetupRecord, changed: SetupRecord, created: UndoId[], options: ChangeOptions): Promise<UndoEvent[]> {
  const undone: UndoEvent[] = [];
  const note = (event: UndoEvent) => {
    undone.push(event);
    options.onUndo?.(event);
  };

  try {
    await upgradeTo(store, cluster, record, options);
    note({ undo: 'upgrade', outcome: 'restored' });
  } catch (err) {
    note({
      undo: 'upgrade', outcome: 'failed', failure: failureOf(err)
    });
    [...created].reverse().forEach((undo) => note({
      undo, outcome: 'kept', failure: { reason: 'upgradeLeft' }
    }));

    return undone;
  }

  return [...undone, ...await undoCreated(store, cluster, changed, created, options)];
}

/**
 * Turns single sign-on on for a Studio installed with its own sign-in (design section 6.7): steps 5
 * to 8 of the setup as an upgrade, which needs a Rancher administrator.
 */
/** What the administrator saw and confirmed before single sign-on: the redirect's host and the namespaces */
export interface SsoConfirmation {
  host: string;
  namespaces: string[];
}

export async function enableSso(store: StoreLike, cluster: string, record: SetupRecord, app: AppInfo, context: RancherContext, confirmed: SsoConfirmation, options: ChangeOptions = {}): Promise<ChangeResult> {
  const problem = recordProblem(record, cluster);

  if (problem) {
    return refused('untrustedRecord', { field: problem });
  }

  if (!context.serverUrl) {
    return refused('ssoUnavailable');
  }

  const live = await unchangedRecord(store, cluster, record);

  if (!live || !await unchangedApp(store, cluster, app)) {
    return refused('changedSinceLoad');
  }

  // The client secret goes into Studio's namespace, which project members must not read
  if (await namespaceInProject(store, cluster)) {
    return refused('inProject', { namespace: STUDIO_NAMESPACE });
  }

  // The redirect goes to the host Studio serves, which the administrator saw and confirmed
  const host = await deployedHost(store, cluster);

  if (!host) {
    return refused('noHost');
  }

  if (host !== confirmed.host) {
    return refused('hostChanged', { host });
  }

  // The namespaces the administrator confirmed, revalidated, never the record's carried forward
  if (namespacesError(confirmed.namespaces, await visibleNamespaces(store))) {
    return refused('badNamespaces');
  }

  const namespaces = [...new Set(confirmed.namespaces)].sort((a, b) => a.localeCompare(b));
  const previous: SetupRecord = {
    ...record, host, namespaces, sso: undefined
  };

  const sso: SsoRecord = {
    client:    oidcClientName(cluster),
    issuer:    oidcIssuer(context.serverUrl),
    scope:     context.scopes.join(' '),
    rancherCA: !!context.cacerts,
  };
  const changed: SetupRecord = {
    ...record, host, namespaces, sso
  };
  const created: UndoId[] = [];
  let clientId = '';
  let upgradeStarted = false;

  const steps: ChangeStepId[] = ['oidcClient', 'oidcSecret', ...(sso.rancherCA ? ['rancherCA'] as ChangeStepId[] : []), 'upgrade', 'saveRecord'];
  const failed = await runSteps<ChangeStepId>(steps, {
    oidcClient: async() => {
      await createOidcClient(store, changed, sso);
      created.push('oidcClient');
      clientId = await waitForClientId(store, sso.client, options);

      return 'done';
    },
    oidcSecret: async() => {
      await copyClientSecret(store, cluster, clientId, options);
      created.push('oidcSecret');

      return 'done';
    },
    rancherCA: async() => {
      await createConfigMap(store, cluster, RANCHER_CA_CONFIGMAP, { [RANCHER_CA_KEY]: context.cacerts as string });
      created.push('rancherCA');

      return 'done';
    },
    upgrade: async() => {
      upgradeStarted = true;
      await upgradeTo(store, cluster, changed, options);

      return 'done';
    },
    saveRecord: async() => {
      await replaceRecord(store, cluster, changed, live.resourceVersion);

      return 'done';
    },
  }, options.onStep, ['oidcSecret']);

  if (!failed) {
    return {
      ok: true, undone: [], record: changed
    };
  }

  // Studio already runs with single sign-on when only the record failed, so nothing is taken back
  let undone: UndoEvent[] = [];

  if (failed.step !== 'saveRecord') {
    undone = upgradeStarted ? await compensate(store, cluster, previous, changed, created, options) : await undoCreated(store, cluster, changed, created, options);
  }

  return {
    ok: false, failedStep: failed.step, failure: failed.failure, undone
  };
}

/**
 * Uninstalls Studio (design section 6.4, Uninstall) after the release name was typed by hand. When
 * the app cannot be uninstalled nothing else is touched. Single sign-on's objects are looked for
 * whatever the record says, since whoever can edit the record could drop them from it; the OIDC
 * client goes only for someone allowed to delete it, and is otherwise named as left behind; the
 * record and the namespace go last, and only when everything before them went, so Settings can
 * finish a later try.
 */
export async function uninstallStudio(store: StoreLike, cluster: string, record: SetupRecord, confirm: string, options: ChangeOptions = {}): Promise<ChangeResult> {
  const problem = recordProblem(record, cluster);

  if (problem) {
    return refused('untrustedRecord', { field: problem });
  }

  if (confirm.trim() !== record.release.name) {
    return refused('notConfirmed');
  }

  if (!await unchangedRecord(store, cluster, record)) {
    return refused('changedSinceLoad');
  }

  const undone: UndoEvent[] = [];
  const note = (event: UndoEvent) => {
    undone.push(event);
    options.onUndo?.(event);
  };
  const args = { namespace: STUDIO_NAMESPACE };

  note(await removeRelease(store, cluster, record.release.namespace, record.release.name, options));

  // An app that could not be uninstalled, or one without the extension's mark, keeps all the rest
  if (undone[0].outcome === 'failed' || undone[0].outcome === 'kept') {
    return { ok: false, undone };
  }

  note(await removeNavLink(store, cluster, `${ record.release.namespace }.${ record.release.name }`));

  // An object the record does not name is reported only when it was there
  const { sso } = record;
  const noteFound = (event: UndoEvent, named: boolean) => {
    if (named || event.outcome !== 'gone') {
      note(event);
    }
  };

  noteFound(await removeRancherCA(store, cluster), !!sso?.rancherCA);
  noteFound(await removeOidcSecret(store, cluster), !!sso);

  const client = oidcClientName(cluster);
  const mayDelete = await canI(store, LOCAL_CLUSTER, {
    group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: client
  });

  if (mayDelete) {
    noteFound(await removeOidcClient(store, client), !!sso);
  } else {
    // Left to an administrator: kept when the record says single sign-on is on, otherwise possibly there
    note(sso ? { undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notAllowed', args: { name: client } } } : {
      undo: 'oidcClient', outcome: 'unchecked', failure: { reason: 'mayBeLeft', args: { name: client } }
    });
  }

  if (undone.some((event) => event.outcome === 'failed')) {
    note({
      undo: 'record', outcome: 'kept', failure: { reason: 'retryLater' }
    });
    note({
      undo: 'namespace', outcome: 'kept', failure: { reason: 'retryLater' }
    });
  } else {
    note(await removeRecord(store, cluster));
    note(record.createdNamespace ? await removeNamespace(store, cluster, false) : {
      undo: 'namespace', outcome: 'kept', failure: { reason: 'notOurs', args }
    });
  }

  return { ok: !undone.some((event) => event.outcome === 'failed'), undone };
}
