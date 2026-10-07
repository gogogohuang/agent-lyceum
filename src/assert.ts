/** For values the program's own invariants guarantee (never for user input): fail loudly instead of `value!`. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`internal: ${what} is missing`);
  return value;
}
