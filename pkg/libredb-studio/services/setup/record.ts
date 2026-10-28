import type { StoreLike } from '../types';
import { kube, kubeGet } from './k8s';
import { MANAGED_LABELS, RECORD_CONFIGMAP, RECORD_KEY, STUDIO_NAMESPACE } from './names';
import { parseRecord, serializeRecord, SetupRecord } from './values';

/** The wizard's ConfigMaps in Studio's namespace: Rancher's CA and the setup record */

const configMaps = `/api/v1/namespaces/${ STUDIO_NAMESPACE }/configmaps`;

function configMap(name: string, data: Record<string, string>): Record<string, unknown> {
  return {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels: { ...MANAGED_LABELS } }, data
  };
}

export function createConfigMap(store: StoreLike, cluster: string, name: string, data: Record<string, string>): Promise<unknown> {
  return kube(store, cluster, 'post', configMaps, configMap(name, data));
}

export function createRecord(store: StoreLike, cluster: string, record: SetupRecord): Promise<unknown> {
  return createConfigMap(store, cluster, RECORD_CONFIGMAP, { [RECORD_KEY]: serializeRecord(record) });
}

/** Replaces the record after a change Studio took */
export function replaceRecord(store: StoreLike, cluster: string, record: SetupRecord): Promise<unknown> {
  return kube(store, cluster, 'put', `${ configMaps }/${ RECORD_CONFIGMAP }`, configMap(RECORD_CONFIGMAP, { [RECORD_KEY]: serializeRecord(record) }));
}

/** The record, whether its ConfigMap is there at all, since an unreadable one is still the wizard's */
export async function readRecord(store: StoreLike, cluster: string): Promise<{ exists: boolean, record?: SetupRecord }> {
  const found = await kubeGet<{ data?: Record<string, string> }>(store, cluster, `${ configMaps }/${ RECORD_CONFIGMAP }`);

  return { exists: !!found, record: parseRecord(found?.data?.[RECORD_KEY]) };
}
