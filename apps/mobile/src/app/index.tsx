import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MONAD_NETWORK, monadChain, publicClient } from '@/chain';

export default function Home() {
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicClient
      .getBlockNumber()
      .then((n) => {
        if (!cancelled) setBlockNumber(n);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sente</Text>
      <Text style={styles.subtitle}>
        {monadChain.name} · {MONAD_NETWORK} · chain {monadChain.id}
      </Text>
      <Text style={styles.body}>
        {error ? `RPC error: ${error}` : `Block ${blockNumber?.toString() ?? '…'}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B0B0F',
    gap: 8,
  },
  title: { color: '#FFFFFF', fontSize: 40, fontWeight: '700', letterSpacing: -1 },
  subtitle: { color: '#8A8AA3', fontSize: 14 },
  body: { color: '#5B5B77', fontSize: 13, marginTop: 12 },
});
