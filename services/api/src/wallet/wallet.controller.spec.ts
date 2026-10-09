import type { Address, Hash } from 'viem';

import type { UserWalletView } from './user-wallet.service';
import { toUserWalletResponse } from './wallet.controller';

const view = (starterKit: UserWalletView['starterKit']): UserWalletView => ({
  userId: 'user',
  walletId: 'w1',
  address: '0x3De96375140717193F52C220Df5eC460971CbE84' as Address,
  ownerQuorumId: 'kq1',
  devicePublicKey: 'key',
  createdAt: new Date('2026-10-09T00:00:00Z'),
  chainId: 10143,
  balances: [],
  starterKit,
});

describe('GET /wallet starterKit (SEN-170)', () => {
  it.each(['disabled', 'none', 'pending'] as const)('carries %s with no hashes', (status) => {
    expect(toUserWalletResponse(view({ status })).starterKit).toEqual({ status });
  });

  it('carries the transfer hashes once sent, and survives JSON', () => {
    const ausdTx = `0x${'a'.repeat(64)}` as Hash;
    const usdcTx = `0x${'b'.repeat(64)}` as Hash;

    const wire = JSON.parse(
      JSON.stringify(toUserWalletResponse(view({ status: 'sent', ausdTx, usdcTx }))),
    ) as { starterKit: unknown };

    expect(wire.starterKit).toEqual({ status: 'sent', ausdTx, usdcTx });
  });
});
