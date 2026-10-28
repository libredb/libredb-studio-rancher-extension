import { METADATA_ONLY } from '../../services/setup/k8s';
import { httpError, Request } from './fake-store';

type KubeObject = { metadata?: { name?: string, labels?: Record<string, string>, annotations?: Record<string, string>, resourceVersion?: string }, [key: string]: unknown };

/** What the API server does after it created an object, such as Rancher assigning an OIDC client its id */
export type Reaction = (created: KubeObject, kube: FakeKube) => void;

/**
 * Kubernetes objects by URL, as the API server answers them: a POST to a collection creates the
 * object named in its body (409 when it exists), GET, PUT and DELETE act on one object (404 when it
 * does not exist). A GET that asks for metadata alone gets only the object's metadata, and a PUT
 * that names a resourceVersion other than the stored one is refused with 409. Use `handle` as the
 * last answer of a fake store, behind the specific ones.
 */
export class FakeKube {
  readonly objects = new Map<string, KubeObject>();

  constructor(seed: Record<string, KubeObject> = {}, private readonly reactions: Record<string, Reaction> = {}) {
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

    const found = this.objects.get(url);

    if (!found) {
      return httpError(404);
    }

    if (method === 'PUT') {
      const expected = body.metadata?.resourceVersion;

      if (expected !== undefined && expected !== found.metadata?.resourceVersion) {
        return httpError(409, 'the object has been modified');
      }

      this.objects.set(url, body);

      return body;
    }

    if (method === 'DELETE') {
      this.objects.delete(url);

      return {};
    }

    if (request.headers?.accept === METADATA_ONLY) {
      return { apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadata', metadata: found.metadata };
    }

    return found;
  };
}

/** Every request a FakeKube should answer: any method on a cluster's Kubernetes API through Rancher */
export const KUBE_REQUESTS = /^(GET|POST|PUT|DELETE) \/k8s\/clusters\/[^/]+\/apis?\//;

/**
 * The reads of a Secret that could bring its data back: every GET of a Secret that does not ask for
 * the metadata alone. Only copying the OIDC client secret, in the administrator's step, may make one.
 */
export const secretDataReads = (calls: Request[]): string[] => calls
  .filter((call) => call.method === 'GET' && /\/secrets\//.test(call.url) && call.headers?.accept !== METADATA_ONLY)
  .map((call) => call.url);
