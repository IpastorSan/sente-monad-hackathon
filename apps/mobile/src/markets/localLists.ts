/**
 * The two lists the Markets tab keeps on the device (SEN-111): recent searches
 * and favourite markets. `expo-secure-store` because the study says so and the
 * app already links it — no new native module for a few hundred bytes. Neither
 * list is a secret; a failed read is an empty list and a failed write is
 * dropped, because losing a recent is not worth an error on screen.
 *
 * The parsing and ordering rules are `marketsView.ts`, under test.
 */
import * as SecureStore from 'expo-secure-store';

import {
  parseFavourites,
  parseRecents,
  pushRecent,
  toggleFavourite,
  type Recent,
} from '@/markets/marketsView';
import type { MarketKey } from '@/markets/select';

const RECENTS_KEY = 'sente.markets.recents';
const FAVOURITES_KEY = 'sente.markets.favourites';

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Best effort: see the header.
  }
}

export async function readRecents(): Promise<Recent[]> {
  return parseRecents(await read(RECENTS_KEY));
}

/** Records `entry` as the newest recent and returns the list as stored. */
export async function addRecent(entry: Recent): Promise<Recent[]> {
  const next = pushRecent(await readRecents(), entry);
  await write(RECENTS_KEY, JSON.stringify(next));
  return next;
}

export async function readFavourites(): Promise<Set<MarketKey>> {
  return parseFavourites(await read(FAVOURITES_KEY));
}

/** Stars or un-stars one market and returns the set as stored. */
export async function flipFavourite(key: MarketKey): Promise<Set<MarketKey>> {
  const next = toggleFavourite(await readFavourites(), key);
  await write(FAVOURITES_KEY, JSON.stringify([...next]));
  return next;
}
