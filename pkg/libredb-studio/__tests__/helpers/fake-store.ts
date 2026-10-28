import type { StoreLike } from '../../services/types';

/** A failed store request, shaped as the dashboard store rejects one */
export function httpError(status: number, message = `HTTP ${ status }`): Error & { _status: number, data: { message: string } } {
  return Object.assign(new Error(message), { _status: status, data: { message } });
}

export interface Request {
  store: string;
  url: string;
  method: string;
  data?: unknown;
}

type Answer = unknown | ((request: Request) => unknown);

export interface FakeStoreSetup {
  /** cluster/schemaFor and management/schemaFor answers, by `<store>/<type>` */
  schemas?: Record<string, unknown>;
  /** find answers by `<store>/<type>/<id>`; an Error rejects, a missing key rejects with 404 */
  find?: Record<string, Answer>;
  /** findAll answers by `<store>/<type>` */
  findAll?: Record<string, Answer>;
  /** findLabelSelector answers by `<store>/<type>` */
  findLabelSelector?: Record<string, Answer>;
  /** request answers by `<METHOD> <url>`, first match wins; a missing one rejects with 404 */
  requests?: [string | RegExp, Answer][];
  getters?: Record<string, unknown>;
}

export interface FakeStore extends StoreLike {
  dispatch: jest.Mock;
  /** Every request made, in order */
  calls: Request[];
}

function settle(answer: Answer, request: Request): Promise<unknown> {
  try {
    const value = typeof answer === 'function' ? (answer as (r: Request) => unknown)(request) : answer;

    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  } catch (err) {
    return Promise.reject(err);
  }
}

/** A dashboard store standing in for Rancher's API: reads by type and id, and raw requests by URL */
export function fakeStore(setup: FakeStoreSetup = {}): FakeStore {
  const calls: Request[] = [];
  const schemaFor = (store: string) => (type: string) => setup.schemas?.[`${ store }/${ type }`];

  const dispatch = jest.fn((action: string, payload: Record<string, unknown> = {}) => {
    const [store, verb] = action.split('/');

    switch (verb) {
    case 'find': {
      const key = `${ store }/${ payload.type }/${ payload.id }`;

      return key in (setup.find || {}) ? settle(setup.find?.[key], {
        store, url: key, method: 'find'
      }) : Promise.reject(httpError(404));
    }
    case 'findAll': {
      const key = `${ store }/${ payload.type }`;

      return settle(setup.findAll?.[key] ?? [], {
        store, url: key, method: 'findAll'
      });
    }
    case 'findLabelSelector': {
      const key = `${ store }/${ payload.type }`;

      return settle(setup.findLabelSelector?.[key] ?? [], {
        store, url: key, method: 'findLabelSelector'
      });
    }
    case 'request': {
      const request = {
        store, url: String(payload.url), method: String(payload.method || 'get').toUpperCase(), data: payload.data
      };
      const line = `${ request.method } ${ request.url }`;
      const match = (setup.requests || []).find(([pattern]) => (typeof pattern === 'string' ? pattern === line : pattern.test(line)));

      calls.push(request);

      return match ? settle(match[1], request) : Promise.reject(httpError(404));
    }
    default:
      return Promise.resolve(undefined);
    }
  });

  return {
    getters: {
      'cluster/schemaFor':    schemaFor('cluster'),
      'management/schemaFor': schemaFor('management'),
      ...(setup.getters || {}),
    } as StoreLike['getters'],
    dispatch,
    calls,
  };
}

/** A SelfSubjectAccessReview answer */
export const reviewAnswer = (allowed: boolean) => ({ status: { allowed } });
