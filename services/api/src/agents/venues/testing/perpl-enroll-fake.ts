/**
 * A fake Perpl enrollment API for specs: `/payload` answers a typed-data
 * payload naming the requested signer, `/enroll` counts and answers a fresh
 * `key-N` (or `failStatus`, as Perpl answers 423 at the 16-key limit).
 * Shared by the PerplAgentAccounts and AgentVenues specs (SEN-148).
 */
export function perplEnrollPayload(address: string) {
  return {
    typed_data: {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
          { name: 'salt', type: 'bytes32' },
        ],
        PerplRegisterApiKey: [
          { name: 'signer', type: 'address' },
          { name: 'statement', type: 'string' },
          { name: 'publicKey', type: 'string' },
          { name: 'scope', type: 'string' },
          { name: 'label', type: 'string' },
          { name: 'time', type: 'uint64' },
        ],
      },
      primaryType: 'PerplRegisterApiKey',
      domain: {
        name: 'perpl.xyz',
        version: '1',
        chainId: '0x279f',
        verifyingContract: '0x0000000000000000000000000000000000000000',
        salt: '0x00000000000000000000000000000000000000006aa2f731368ca5c38d4d3fb0',
      },
      message: {
        signer: address,
        statement:
          'I authorize the creation of Perpl API key with the specified scope and parameters',
        publicKey: 'k',
        scope: '3',
        label: 'x',
        time: '0x1a08c959a61',
      },
    },
    mac: '0xmac',
  };
}

export interface PerplEnrollFake {
  readonly fetchImpl: typeof fetch;
  /** `/enroll` calls, answered or refused. */
  readonly enrollments: number;
  /** Make every `/enroll` answer this status from now on; `undefined` to succeed again. */
  failStatus: number | undefined;
}

export function perplEnrollFake(): PerplEnrollFake {
  const fake = {
    enrollments: 0,
    failStatus: undefined as number | undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/payload')) {
        return new Response(JSON.stringify(perplEnrollPayload(String(body['address']))));
      }
      fake.enrollments += 1;
      if (fake.failStatus !== undefined) {
        return new Response('{"error":"limit"}', { status: fake.failStatus });
      }
      return new Response(
        JSON.stringify({
          api_key: {
            api_key: `key-${fake.enrollments}`,
            address: body['address'],
            scope_mask: 3,
            label: 'x',
            origin: '',
            expires_at: 0,
            created_at: 0,
          },
        }),
      );
    }) as typeof fetch,
  };
  return fake;
}
