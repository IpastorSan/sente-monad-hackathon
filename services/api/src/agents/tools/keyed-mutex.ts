/**
 * One task at a time per key; different keys run concurrently.
 *
 * The Tool Runner executes a turn's parallel tool calls with `Promise.all`,
 * and an MCP client may do the same, so two writes for one agent can arrive
 * together. Serialising them keeps "check the mandate, then act" atomic per
 * agent: no write is checked against a state another write is changing.
 * In-process only, like the in-memory stores.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with a task queued or running. */
  get size(): number {
    return this.tails.size;
  }
}
