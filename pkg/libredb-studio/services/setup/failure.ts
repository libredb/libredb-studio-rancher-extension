import { statusOf } from '../studio-status';

/** Why a step failed: an l10n key under libredbStudio.setup.failure, with its arguments */
export interface Failure {
  reason: string;
  args?: Record<string, string>;
}

/** A failure the steps name themselves, rather than a request Rancher refused */
export class StepFailure extends Error {
  constructor(readonly reason: string, readonly args?: Record<string, string>) {
    super(reason);
  }
}

const MAX_DETAIL = 300;

/**
 * What the page may show about a failure: the reason a step named, or the HTTP status with the
 * server's message. Where the request carried or read the OIDC client secret, only the status, so
 * nothing the server echoed back can reach the page.
 */
export function failureOf(err: unknown, { secret = false } = {}): Failure {
  if (err instanceof StepFailure) {
    return err.args ? { reason: err.reason, args: err.args } : { reason: err.reason };
  }

  const status = statusOf(err);
  const failed = err as { data?: { message?: string }, message?: string } | undefined;
  const said = secret ? '' : String(failed?.data?.message || failed?.message || '').slice(0, MAX_DETAIL);
  let detail = said || 'request failed';

  if (status) {
    detail = said ? `HTTP ${ status }: ${ said }` : `HTTP ${ status }`;
  }

  return { reason: 'request', args: { detail } };
}
