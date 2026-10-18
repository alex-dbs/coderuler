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
): Promise<R[]> {
  requirePositiveSafeInteger(concurrency);

  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.min(items.length, concurrency);
  let nextIndex = 0;
  let failureObserved = false;
  let failure: unknown;

  // A mapper may need to drain started work after it has already failed.
  const reportFailure = (error: unknown): void => {
    if (!failureObserved) {
      failureObserved = true;
      failure = error;
    }
  };

  const runWorker = async (): Promise<void> => {
    while (!failureObserved) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index, reportFailure);
      } catch (error) {
        reportFailure(error);
      }
    }
  };

  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);
  if (failureObserved) throw failure;
  return results;
}
