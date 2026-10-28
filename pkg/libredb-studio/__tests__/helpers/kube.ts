import { httpError, Request } from './fake-store';

type KubeObject = { metadata?: { name?: string, labels?: Record<string, string>, annotations?: Record<string, string> }, [key: string]: unknown };

/** What the API server does after it created an object, such as Rancher assigning an OIDC client its id */
export type Reaction = (created: KubeObject, kube: FakeKube) => void;

/**
 * Kubernetes objects by URL, as the API server answers them: a POST to a collection creates the
 * object named in its body (409 when it exists), GET, PUT and DELETE act on one object (404 when it
 * does not exist). Use `handle` as the last answer of a fake store, behind the specific ones.
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

    if (!this.objects.has(url)) {
      return httpError(404);
    }

    if (method === 'PUT') {
      this.objects.set(url, body);

      return body;
    }

    if (method === 'DELETE') {
      this.objects.delete(url);

      return {};
    }

    return this.objects.get(url);
  };
}

/** Every request a FakeKube should answer: any method on a cluster's Kubernetes API through Rancher */
export const KUBE_REQUESTS = /^(GET|POST|PUT|DELETE) \/k8s\/clusters\/[^/]+\/apis?\//;
