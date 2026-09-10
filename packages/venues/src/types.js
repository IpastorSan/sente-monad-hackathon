/**
 * Shared value types for every Sente venue adapter.
 *
 * Amounts and prices are carried as decimal STRINGS, never `number`. A JS
 * number cannot hold a wei-scale integer and silently rounds mid-size fills,
 * which is the classic way to lose money in a trading client. Adapters convert
 * to and from their venue's native representation at the boundary.
 */
export {};
