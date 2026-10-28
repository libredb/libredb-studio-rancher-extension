/** How the setup steps wait; tests replace the clock */
export interface WaitOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Asks the probe every interval until it answers, or the timeout passes: then nothing, or the
 * probe's last failure when it kept failing. A failure that clears in time is waited out.
 */
export async function waitFor<T>(probe: () => Promise<T | undefined>, intervalMs: number, timeoutMs: number, { sleep = realSleep, now = Date.now }: WaitOptions = {}): Promise<T | undefined> {
  const deadline = now() + timeoutMs;

  for (;;) {
    let failure: unknown;
    let failed = false;

    try {
      const value = await probe();

      if (value !== undefined) {
        return value;
      }
    } catch (err) {
      failure = err;
      failed = true;
    }

    if (now() >= deadline) {
      if (failed) {
        throw failure;
      }

      return undefined;
    }

    await sleep(intervalMs);
  }
}
