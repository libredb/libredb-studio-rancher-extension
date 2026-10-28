import { Failure, failureOf } from './failure';

export type StepState = 'running' | 'done' | 'skipped' | 'failed';

export interface StepEvent<S extends string = string> {
  step: S;
  state: StepState;
  failure?: Failure;
}

/**
 * Runs the steps in order, each reported as it starts and ends, and stops at the first failure,
 * which it answers. A step that reads or writes the OIDC client secret reports a failure by its
 * HTTP status alone.
 */
export async function runSteps<S extends string>(
  steps: S[],
  work: Record<S, () => Promise<'done' | 'skipped'>>,
  onStep: ((event: StepEvent<S>) => void) | undefined,
  secretSteps: S[] = []
): Promise<{ step: S, failure: Failure } | undefined> {
  for (const step of steps) {
    onStep?.({ step, state: 'running' });

    try {
      onStep?.({ step, state: await work[step]() });
    } catch (err) {
      const failure = failureOf(err, { secret: secretSteps.includes(step) });

      onStep?.({
        step, state: 'failed', failure
      });

      return { step, failure };
    }
  }

  return undefined;
}
