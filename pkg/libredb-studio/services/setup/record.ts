import type { StoreLike } from '../types';
import { kube, kubeGet } from './k8s';
import { MANAGED_LABELS, RECORD_CONFIGMAP, RECORD_KEY, STUDIO_NAMESPACE } from './names';
import { parseRecord, serializeRecord, SetupRecord } from './values';

/** The wizard's ConfigMaps in Studio's namespace: Rancher's CA and the setup record */

const configMaps = `/api/v1/namespaces/${ STUDIO_NAMESPACE }/configmaps`;

function configMap(name: string, data: Record<string, string>, resourceVersion?: string): Record<string, unknown> {
  const metadata = resourceVersion ? {
    name, labels: { ...MANAGED_LABELS }, resourceVersion
  } : { name, labels: { ...MANAGED_LABELS } };

  return {
    apiVersion: 'v1', kind: 'ConfigMap', metadata, data
  };
}

export function createConfigMap(store: StoreLike, cluster: string, name: string, data: Record<string, string>): Promise<unknown> {
  return kube(store, cluster, 'post', configMaps, configMap(name, data));
}

export function createRecord(store: StoreLike, cluster: string, record: SetupRecord): Promise<unknown> {
  return createConfigMap(store, cluster, RECORD_CONFIGMAP, { [RECORD_KEY]: serializeRecord(record) });
}

/**
 * Replaces the record after a change Studio took, only over the version it read: the API server
 * refuses the write with 409 when someone else wrote the record since.
 */
export function replaceRecord(store: StoreLike, cluster: string, record: SetupRecord, resourceVersion: string | undefined): Promise<unknown> {
  return kube(store, cluster, 'put', `${ configMaps }/${ RECORD_CONFIGMAP }`, configMap(RECORD_CONFIGMAP, { [RECORD_KEY]: serializeRecord(record) }, resourceVersion));
}

export interface ReadRecord {
  /** Whether its ConfigMap is there at all, since an unreadable one is still the wizard's */
  exists: boolean;
  record?: SetupRecord;
  /** The ConfigMap's version, which a replacement names */
  resourceVersion?: string;
}

export async function readRecord(store: StoreLike, cluster: string): Promise<ReadRecord> {
  const found = await kubeGet<{ metadata?: { resourceVersion?: string }, data?: Record<string, string> }>(store, cluster, `${ configMaps }/${ RECORD_CONFIGMAP }`);

  return {
    exists: !!found, record: parseRecord(found?.data?.[RECORD_KEY]), resourceVersion: found?.metadata?.resourceVersion
  };
}
