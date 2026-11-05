function invalidConcurrency(received: string): RangeError {
  return new RangeError(`--concurrency must be a positive safe integer, received ${received}`);
}

function requirePositiveSafeInteger(concurrency: number): void {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw invalidConcurrency(String(concurrency));
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number, reportFailure: (error: unknown) => void) => Promise<R>,
  scheduler: (work: Promise<R>) => Promise<R> = work => work,
): Promise<R[]> {
  requirePositiveSafeInteger(concurrency);

  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.min(items.length, concurrency);
  let nextIndex = 0;
  let failureObserved = false;
  const { promise: failureSignal, resolve: signalFailure } =
    Promise.withResolvers<{ readonly error: unknown }>();

  // A mapper may report failure before its own cleanup finishes.
  const reportFailure = (error: unknown): void => {
    if (!failureObserved) {
      failureObserved = true;
      signalFailure({ error });
    }
  };

  const runWorker = async (): Promise<void> => {
    while (!failureObserved) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        const work = scheduler(Promise.resolve().then(() => mapper(items[index]!, index, reportFailure)));
        results[index] = await work;
      } catch (error) {
        reportFailure(error);
      }
    }
  };

  const workers = Array.from({ length: workerCount }, () => runWorker());
  const outcome = await Promise.race([
    Promise.all(workers).then(() => ({ error: undefined, failed: false as const })),
    failureSignal.then(({ error }) => ({ error, failed: true as const })),
  ]);
  if (outcome.failed) throw outcome.error;
  return results;
}
