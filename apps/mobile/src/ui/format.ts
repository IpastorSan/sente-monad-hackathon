/** `0x1234…abcd`. Lists only — screens that ask for trust show the whole address. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The date part of an ISO timestamp, e.g. `2026-09-11`. Same on every device. */
export function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}
