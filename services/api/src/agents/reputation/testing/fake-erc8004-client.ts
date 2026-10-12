import type {
  Erc8004AgentRegistration,
  Erc8004Client,
  Erc8004FeedbackWrite,
  Erc8004MetadataEntry,
  Erc8004Receipt,
} from '../erc8004';

/**
 * The chain, as a spec sees it: what was written, and a way to make the next
 * write fail. Shared by the SEN-27 and SEN-194 specs.
 */
export class FakeErc8004Client implements Erc8004Client {
  readonly registrations: string[] = [];
  /** The metadata each registration carried, index for index with `registrations`. */
  readonly registrationMetadata: (readonly Erc8004MetadataEntry[])[] = [];
  readonly feedback: Erc8004FeedbackWrite[] = [];
  readonly metadataWrites: {
    agentId: bigint;
    entry: Erc8004MetadataEntry;
    txHash: `0x${string}`;
  }[] = [];
  nextAgentId = 1874n;
  registerError: Error | undefined;
  feedbackError: Error | undefined;
  /** Each `setMetadata` shifts one: an Error rejects, `undefined` lands. */
  metadataErrors: (Error | undefined)[] = [];

  register(
    agentUri: string,
    metadata: readonly Erc8004MetadataEntry[] = [],
  ): Promise<Erc8004AgentRegistration> {
    if (this.registerError) return Promise.reject(this.registerError);
    this.registrations.push(agentUri);
    this.registrationMetadata.push(metadata);
    return Promise.resolve({ agentId: this.nextAgentId, txHash: `0x${'ab'.repeat(32)}` });
  }

  giveFeedback(feedback: Erc8004FeedbackWrite): Promise<Erc8004Receipt> {
    if (this.feedbackError) return Promise.reject(this.feedbackError);
    this.feedback.push(feedback);
    return Promise.resolve({ txHash: `0x${'cd'.repeat(32)}`, blockNumber: 42n });
  }

  setMetadata(agentId: bigint, entry: Erc8004MetadataEntry): Promise<Erc8004Receipt> {
    const error = this.metadataErrors.shift();
    if (error) return Promise.reject(error);
    const n = this.metadataWrites.length + 1;
    const txHash = `0x${n.toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`;
    this.metadataWrites.push({ agentId, entry, txHash });
    return Promise.resolve({ txHash, blockNumber: 43n });
  }
}
