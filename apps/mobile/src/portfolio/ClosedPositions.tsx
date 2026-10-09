/**
 * The Closed half of Positions (SEN-154): your round trips rebuilt from your
 * fills (`closed.ts`), with realised P&L and dates.
 *
 * FIFO over a partial history is wrong, not approximate, so while this list
 * is on screen it reads older pages until every venue's history is in, and
 * until then (or when a venue failed, or Perpl is not linked) it names what
 * is missing instead of showing a total.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Loading, Notice } from '@/ui/kit';
import { text } from '@/ui/theme';

import { closedList, closedNotes, closedRow, closedTotal } from './closed';
import { ClosedPositionRow } from './parts';
import type { useFills } from './usePortfolio';

export function ClosedPositions({
  fills,
  hidden,
}: {
  fills: ReturnType<typeof useFills>;
  hidden: boolean;
}) {
  const list = closedList(fills.fills, fills.coverage);
  const { hasMore, loadingMore, moreFailed, loadMore } = fills;

  // Page back to the first fill on our own: a closed position is only right
  // once the fills before it are in. A failed page stops here and offers a
  // retry, rather than hammering the route.
  useEffect(() => {
    if (hasMore && !loadingMore && !moreFailed) loadMore();
  }, [hasMore, loadingMore, moreFailed, loadMore]);

  if (list.reading) return <Loading />;
  const total = closedTotal(list.total, hidden);
  const notes = closedNotes(list);

  return (
    <View>
      {total !== null && list.positions.length > 0 ? (
        <View style={styles.total}>
          <Text style={text.label}>Realised</Text>
          <Text style={[text.strong, text.num]}>{total}</Text>
        </View>
      ) : null}
      {list.gaps.length > 0 ? (
        <View style={styles.gap}>
          <Notice
            tone="info"
            title={
              list.positions.length > 0
                ? 'Not every closed position is here yet'
                : 'Closed positions aren’t ready yet'
            }
            detail={`${list.gaps.join(' ')} The total waits until they are all in.`}
          />
        </View>
      ) : null}
      {moreFailed ? (
        <Button
          label="Read older fills again"
          kind="soft"
          size="sm"
          onPress={loadMore}
          style={styles.retry}
        />
      ) : null}
      {list.positions.length === 0 && list.gaps.length === 0 ? (
        <Text style={[text.dim, styles.empty]}>
          No closed positions yet. A position shows here once you have sold or closed all of it.
        </Text>
      ) : null}
      {list.positions.map((p, i) => (
        <ClosedPositionRow
          key={p.key}
          row={closedRow(p, hidden)}
          last={i === list.positions.length - 1}
        />
      ))}
      {list.positions.length > 0 && notes.length > 0 ? (
        <Text style={[text.caption, styles.note]}>{notes.join(' ')}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  total: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  gap: { marginTop: 10 },
  retry: { marginTop: 10, alignSelf: 'flex-start' },
  empty: { marginTop: 10 },
  note: { marginTop: 10 },
});
