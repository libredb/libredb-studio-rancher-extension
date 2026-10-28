import { findStudioLinks, selectStudioLink, StudioLink } from '../navlink';
import { studioStatus, StudioStatus } from '../studio-status';
import type { StoreLike } from '../types';
import {
  removeNamespace, removeNavLink, removeOidcClient, removeOidcSecret, removeRancherCA, removeRecord, removeRelease, undoCreated, UndoEvent, UndoId
} from './cleanup';
import { Failure, failureOf } from './failure';
import { canI, findAllIfVisible, LOCAL_CLUSTER } from './k8s';
import {
  RANCHER_CA_CONFIGMAP, RANCHER_CA_KEY, RELEASE_NAME, STUDIO_NAMESPACE, oidcClientName
} from './names';
import { copyClientSecret, createOidcClient, waitForClientId } from './oidc-client';
import {
  aggregationCheck, rancherContext, ssoChecks, Check, RancherContext
} from './preflight';
import { createConfigMap, readRecord, replaceRecord } from './record';
import { releaseState, upgradeRelease, waitForRelease, Operation } from './release';
import { runSteps, StepEvent } from './steps';
import type { SetupRecord, SsoRecord } from './values';
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
}

export interface StudioSettings {
  /** Whether the user owns the cluster; nothing else is read for anyone else */
  canChange: boolean;
  record?: SetupRecord;
  /** The record is there but is not one this version wrote */
  recordUnreadable: boolean;
  app?: AppInfo;
  link?: StudioLink;
  status?: StudioStatus;
  aggregation?: Check;
  /** The namespaces discovery may cover */
  namespaces: string[];
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

export async function loadSettings(store: StoreLike, cluster: string): Promise<StudioSettings> {
  if (!await canI(store, cluster, {
    verb: '*', group: '*', resource: '*'
  })) {
    return {
      canChange: false, recordUnreadable: false, namespaces: []
    };
  }

  const { exists, record } = await readRecord(store, cluster);
  const release = record?.release || { namespace: STUDIO_NAMESPACE, name: RELEASE_NAME };
  const state = await releaseState(store, cluster, release.namespace, release.name);
  const { link } = selectStudioLink(await findStudioLinks(store));
  const namespaces = await findAllIfVisible<{ metadata: { name: string } }>(store, 'namespace');
  let sso: StudioSettings['sso'];

  if (record && !record.sso) {
    const context = await rancherContext(store);

    sso = { ...await ssoChecks(store, cluster, context.serverUrl), context };
  }

  return {
    canChange:        true,
    record,
    recordUnreadable: exists && !record,
    app:              state && {
      chartVersion: state.chartVersion, appVersion: state.appVersion, status: state.status, revision: state.revision
    },
    link,
    status:      await studioStatus(store, link),
    aggregation: await aggregationCheck(store),
    namespaces:  namespaces.map((item) => item.metadata.name).filter((name) => name !== STUDIO_NAMESPACE).sort((a, b) => a.localeCompare(b)),
    sso,
  };
}

/** Upgrades Studio to the changed record, at the app's chart version, and waits for it */
async function upgradeTo(store: StoreLike, cluster: string, record: SetupRecord, app: AppInfo, options: WaitOptions): Promise<void> {
  const operation: Operation = await upgradeRelease(store, cluster, record, app.chartVersion || record.release.chartVersion);

  await waitForRelease(store, cluster, record, operation, app.revision, options);
}

/** Changes the namespaces Studio discovers */
export async function saveNamespaces(store: StoreLike, cluster: string, record: SetupRecord, app: AppInfo, namespaces: string[], options: ChangeOptions = {}): Promise<ChangeResult> {
  const changed: SetupRecord = { ...record, namespaces: [...new Set(namespaces)].sort((a, b) => a.localeCompare(b)) };
  const failed = await runSteps<ChangeStepId>(['upgrade', 'saveRecord'], {
    upgrade: async() => {
      await upgradeTo(store, cluster, changed, app, options);

      return 'done';
    },
    saveRecord: async() => {
      await replaceRecord(store, cluster, changed);

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
async function compensate(store: StoreLike, cluster: string, record: SetupRecord, changed: SetupRecord, app: AppInfo, created: UndoId[], options: ChangeOptions): Promise<UndoEvent[]> {
  const undone: UndoEvent[] = [];
  const note = (event: UndoEvent) => {
    undone.push(event);
    options.onUndo?.(event);
  };

  try {
    const now = await releaseState(store, cluster, record.release.namespace, record.release.name);

    await upgradeTo(store, cluster, record, { ...app, revision: now?.revision ?? app.revision }, options);
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
export async function enableSso(store: StoreLike, cluster: string, record: SetupRecord, app: AppInfo, context: RancherContext, options: ChangeOptions = {}): Promise<ChangeResult> {
  if (!context.serverUrl) {
    return {
      ok: false, failure: { reason: 'ssoUnavailable' }, undone: []
    };
  }

  const sso: SsoRecord = {
    client:    oidcClientName(cluster),
    issuer:    `${ context.serverUrl.replace(/\/+$/, '') }/oidc`,
    scope:     context.scopes.join(' '),
    rancherCA: !!context.cacerts,
  };
  const changed: SetupRecord = { ...record, sso };
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
      await upgradeTo(store, cluster, changed, app, options);

      return 'done';
    },
    saveRecord: async() => {
      await replaceRecord(store, cluster, changed);

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
    undone = upgradeStarted ? await compensate(store, cluster, record, changed, app, created, options) : await undoCreated(store, cluster, changed, created, options);
  }

  return {
    ok: false, failedStep: failed.step, failure: failed.failure, undone
  };
}

/**
 * Uninstalls Studio (design section 6.4, Uninstall) after the release name was typed by hand. When
 * the app cannot be uninstalled nothing else is touched; the OIDC client goes only for someone
 * allowed to delete it, and is otherwise named as left behind; the record and the namespace go last,
 * and only when everything before them went, so Settings can finish a later try.
 */
export async function uninstallStudio(store: StoreLike, cluster: string, record: SetupRecord, confirm: string, options: ChangeOptions = {}): Promise<ChangeResult> {
  if (confirm.trim() !== record.release.name) {
    return {
      ok: false, failure: { reason: 'notConfirmed' }, undone: []
    };
  }

  const undone: UndoEvent[] = [];
  const note = (event: UndoEvent) => {
    undone.push(event);
    options.onUndo?.(event);
  };
  const args = { namespace: STUDIO_NAMESPACE };

  note(await removeRelease(store, cluster, record.release.namespace, record.release.name, options));

  if (undone[0].outcome === 'failed') {
    return { ok: false, undone };
  }

  note(await removeNavLink(store, cluster, `${ record.release.namespace }.${ record.release.name }`));

  if (record.sso) {
    if (record.sso.rancherCA) {
      note(await removeRancherCA(store, cluster));
    }
    note(await removeOidcSecret(store, cluster));

    const client = record.sso.client;
    const mayDelete = await canI(store, LOCAL_CLUSTER, {
      group: 'management.cattle.io', resource: 'oidcclients', verb: 'delete', name: client
    });

    note(mayDelete ? await removeOidcClient(store, client) : {
      undo: 'oidcClient', outcome: 'kept', failure: { reason: 'notAllowed', args: { name: client } }
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
