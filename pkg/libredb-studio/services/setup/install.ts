import type { StudioLink } from '../navlink';
import type { StoreLike } from '../types';
import { undoCreated, UndoEvent, UndoId } from './cleanup';
import { Failure, StepFailure } from './failure';
import { kube, kubeGet } from './k8s';
import { MANAGED_LABELS, RANCHER_CA_CONFIGMAP, RANCHER_CA_KEY, STUDIO_NAMESPACE } from './names';
import { copyClientSecret, createOidcClient, waitForClientId } from './oidc-client';
import { createConfigMap, createRecord } from './record';
import { installRelease, waitForRelease, waitForStudio } from './release';
import { runSteps, StepEvent as AnyStepEvent, StepState } from './steps';
import type { SetupRecord, SsoRecord } from './values';
import type { WaitOptions } from './wait';

export type { UndoEvent } from './cleanup';
export type { StepState } from './steps';

/**
 * F6's apply, design section 6.4 steps 4 to 10: each step reported as it runs, and on a failure
 * everything this run created removed again, in reverse order.
 */
export type StepId = 'namespace' | 'oidcClient' | 'oidcSecret' | 'rancherCA' | 'record' | 'install' | 'ready';
export type StepEvent = AnyStepEvent<StepId>;

/** A step as a page shows it: pending until it starts; F7's upgrade and uninstall steps too */
export interface StepView {
  step: string;
  state: 'pending' | StepState;
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
      await createRecord(store, cluster, { ...record, createdNamespace: created.includes('namespace') });
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

  const failed = await runSteps(plannedSteps(plan), work, options.onStep, ['oidcSecret']);

  if (failed) {
    const undone = await undoCreated(store, cluster, record, created, options);

    return {
      ok: false, failedStep: failed.step, failure: failed.failure, undone
    };
  }

  return {
    ok: true, undone: [], link
  };
}
