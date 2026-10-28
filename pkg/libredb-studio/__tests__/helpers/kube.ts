import { METADATA_LIST_ONLY, METADATA_ONLY } from '../../services/setup/k8s';
import { httpError, Request } from './fake-store';

type KubeObject = {
  metadata?: { name?: string, labels?: Record<string, string>, annotations?: Record<string, string>, resourceVersion?: string, generation?: number, deletionTimestamp?: string },
  [key: string]: unknown
};

/**
 * What the API server or a controller does after an object was created or changed, such as Rancher
 * assigning an OIDC client its id, or regenerating its secret for an annotation
 */
export type Reaction = (object: KubeObject, kube: FakeKube) => void;

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A JSON merge patch (RFC 7386): objects merge, null removes a key, anything else replaces */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const merged: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};

  Object.entries(patch).forEach(([key, value]) => {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = mergePatch(merged[key], value);
    }
  });

  return merged;
}

/**
 * Kubernetes objects by URL, as the API server answers them: a POST to a collection creates the
 * object named in its body (409 when it exists), GET, PUT, PATCH and DELETE act on one object (404
 * when it does not exist). A GET that asks for metadata alone gets only the object's metadata, and
 * a GET of a collection that asks for its metadata alone lists the metadata of the objects in it. A PUT
 * or a merge patch that names a resourceVersion other than the stored one is refused with 409, and
 * a patch that touches the spec raises the object's generation, as it does for a Deployment. Use
 * `handle` as the last answer of a fake store, behind the specific ones.
 */
export class FakeKube {
  readonly objects = new Map<string, KubeObject>();

  /**
   * `reactions` run after an object at that URL was created, `updates` after one was changed by a
   * PUT or a PATCH, each on the stored copy.
   */
  constructor(seed: Record<string, KubeObject> = {}, private readonly reactions: Record<string, Reaction> = {}, private readonly updates: Record<string, Reaction> = {}) {
    Object.entries(seed).forEach(([url, object]) => this.objects.set(url, object));
  }

  handle = (request: Request): unknown => {
    const { method, url } = request;
    const body = request.data as KubeObject;

    if (method === 'POST') {
      const created = `${ url }/${ body.metadata?.name }`;

      if (this.objects.has(created)) {
        return httpError(409, 'already exists');
      }

      // A copy, so a reaction never changes the request a test reads back
      const stored = JSON.parse(JSON.stringify(body)) as KubeObject;

      this.objects.set(created, stored);
      this.reactions[created]?.(stored, this);

      return stored;
    }

    if (method === 'GET' && request.headers?.accept === METADATA_LIST_ONLY) {
      const items = [...this.objects.entries()]
        .filter(([key]) => key.startsWith(`${ url }/`) && !key.slice(url.length + 1).includes('/'))
        .map(([, object]) => ({ metadata: object.metadata }));

      return {
        apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadataList', items
      };
    }

    const found = this.objects.get(url);

    if (!found) {
      return httpError(404);
    }

    if (method === 'PUT' || method === 'PATCH') {
      const expected = body.metadata?.resourceVersion;

      if (expected !== undefined && expected !== found.metadata?.resourceVersion) {
        return httpError(409, 'the object has been modified');
      }

      // A copy again, which an update reaction may change
      const sent = JSON.parse(JSON.stringify(body)) as KubeObject;
      const stored = method === 'PUT' ? sent : mergePatch(found, sent) as KubeObject;

      if (method === 'PATCH' && 'spec' in body) {
        stored.metadata = { ...stored.metadata, generation: (found.metadata?.generation || 1) + 1 };
      }

      this.objects.set(url, stored);
      this.updates[url]?.(stored, this);

      return stored;
    }

    if (method === 'DELETE') {
      this.objects.delete(url);

      return {};
    }

    if (request.headers?.accept === METADATA_ONLY) {
      return {
        apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadata', metadata: found.metadata
      };
    }

    return found;
  };
}

/** Every request a FakeKube should answer: any method on a cluster's Kubernetes API through Rancher */
export const KUBE_REQUESTS = /^(GET|POST|PUT|PATCH|DELETE) \/k8s\/clusters\/[^/]+\/apis?\//;

/**
 * The reads of a Secret that could bring its data back: every GET of a Secret that does not ask for
 * the metadata alone. Only copying the OIDC client secret, in the administrator's step, may make one.
 */
export const secretDataReads = (calls: Request[]): string[] => calls
  .filter((call) => call.method === 'GET' && /\/secrets\//.test(call.url) && call.headers?.accept !== METADATA_ONLY)
  .map((call) => call.url);
