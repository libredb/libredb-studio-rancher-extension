import type { StudioLink } from '../navlink';
import type { StoreLike } from '../types';
import {
  removeNamespace, removeOidcClient, removeOidcSecret, removeRancherCA, removeRecord, removeRelease, UndoEvent, UndoId
} from './cleanup';
import { Failure, failureOf, StepFailure } from './failure';
import { kube, kubeGet } from './k8s';
import {
  MANAGED_LABELS, RANCHER_CA_CONFIGMAP, RANCHER_CA_KEY, RECORD_CONFIGMAP, RECORD_KEY, STUDIO_NAMESPACE
} from './names';
import { copyClientSecret, createOidcClient, waitForClientId } from './oidc-client';
import { installRelease, waitForRelease, waitForStudio } from './release';
import { serializeRecord, SetupRecord, SsoRecord } from './values';
import type { WaitOptions } from './wait';

export type { UndoEvent } from './cleanup';

/**
 * F6's apply, design section 6.4 steps 4 to 10: each step reported as it runs, and on a failure
 * everything this run created removed again, in reverse order.
 */
export type StepId = 'namespace' | 'oidcClient' | 'oidcSecret' | 'rancherCA' | 'record' | 'install' | 'ready';
export type StepState = 'running' | 'done' | 'skipped' | 'failed';

export interface StepEvent {
  step: StepId;
  state: StepState;
  failure?: Failure;
}

export interface SetupPlan {
  cluster: string;
  record: SetupRecord;
  /** Rancher's CA, which the record's single sign-on copies when it has one */
  cacerts?: string;
}

export interface InstallOptions extends WaitOptions {
  onStep?: (event: StepEvent) => void;
  onUndo?: (event: UndoEvent) => void;
}

export interface InstallResult {
  ok: boolean;
  failedStep?: StepId;
  failure?: Failure;
  undone: UndoEvent[];
  link?: StudioLink;
}

const PROJECT_ANNOTATION = 'field.cattle.io/projectId';

export function plannedSteps({ record }: SetupPlan): StepId[] {
  return [
    'namespace',
    ...(record.sso ? ['oidcClient', 'oidcSecret'] as StepId[] : []),
    ...(record.sso?.rancherCA ? ['rancherCA'] as StepId[] : []),
    'record',
    'install',
    'ready',
  ];
}

export function createConfigMap(store: StoreLike, cluster: string, name: string, data: Record<string, string>): Promise<unknown> {
  return kube(store, cluster, 'post', `/api/v1/namespaces/${ STUDIO_NAMESPACE }/configmaps`, {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels: { ...MANAGED_LABELS } }, data
  });
}

/** Removes, newest first, what this run created */
async function rollback(store: StoreLike, plan: SetupPlan, created: UndoId[], options: InstallOptions): Promise<UndoEvent[]> {
  const { cluster, record } = plan;
  const undone: UndoEvent[] = [];
  const undo: Record<string, () => Promise<UndoEvent>> = {
    release:    () => removeRelease(store, cluster, record.release.namespace, record.release.name, options),
    record:     () => removeRecord(store, cluster),
    rancherCA:  () => removeRancherCA(store, cluster),
    oidcSecret: () => removeOidcSecret(store, cluster),
    oidcClient: () => removeOidcClient(store, (record.sso as SsoRecord).client),
    namespace:  () => removeNamespace(store, cluster, undone.some((item) => item.undo === 'release' && item.outcome === 'failed')),
  };

  for (const id of [...created].reverse()) {
    const result = await undo[id]();

    undone.push(result);
    options.onUndo?.(result);
  }

  return undone;
}

/** Installs Studio in Rancher mode as the plan says, as the signed-in user */
export async function installStudio(store: StoreLike, plan: SetupPlan, options: InstallOptions = {}): Promise<InstallResult> {
  const { cluster, record } = plan;
  const created: UndoId[] = [];
  let clientId = '';
  let link: StudioLink | undefined;

  const work: Record<StepId, () => Promise<'done' | 'skipped'>> = {
    namespace: async() => {
      const existing = await kubeGet<{ metadata?: { annotations?: Record<string, string> } }>(store, cluster, `/api/v1/namespaces/${ STUDIO_NAMESPACE }`);

      if (existing) {
        // The preflight checked this; a namespace moved into a project since is refused all the same
        if (existing.metadata?.annotations?.[PROJECT_ANNOTATION]) {
          throw new StepFailure('inProject', { namespace: STUDIO_NAMESPACE });
        }

        return 'skipped';
      }

      await kube(store, cluster, 'post', '/api/v1/namespaces', {
        apiVersion: 'v1', kind: 'Namespace', metadata: { name: STUDIO_NAMESPACE, labels: { ...MANAGED_LABELS } }
      });
      created.push('namespace');

      return 'done';
    },
    oidcClient: async() => {
      const sso = record.sso as SsoRecord;

      await createOidcClient(store, record, sso);
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
      if (!plan.cacerts) {
        throw new StepFailure('noRancherCA');
      }

      await createConfigMap(store, cluster, RANCHER_CA_CONFIGMAP, { [RANCHER_CA_KEY]: plan.cacerts });
      created.push('rancherCA');

      return 'done';
    },
    record: async() => {
      await createConfigMap(store, cluster, RECORD_CONFIGMAP, { [RECORD_KEY]: serializeRecord({ ...record, createdNamespace: created.includes('namespace') }) });
      created.push('record');

      return 'done';
    },
    install: async() => {
      const operation = await installRelease(store, cluster, record);

      created.push('release');
      await waitForRelease(store, cluster, record, operation, 0, options);

      return 'done';
    },
    ready: async() => {
      link = await waitForStudio(store, cluster, options);

      return 'done';
    },
  };

  for (const step of plannedSteps(plan)) {
    options.onStep?.({ step, state: 'running' });

    try {
      options.onStep?.({ step, state: await work[step]() });
    } catch (err) {
      const failure = failureOf(err, { secret: step === 'oidcSecret' });

      options.onStep?.({
        step, state: 'failed', failure
      });

      return {
        ok: false, failedStep: step, failure, undone: await rollback(store, plan, created, options)
      };
    }
  }

  return {
    ok: true, undone: [], link
  };
}
