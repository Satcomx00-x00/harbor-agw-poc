import assert from "node:assert/strict";

/**
 * Capture a thrown error so it can be asserted on.
 *
 * `assert.throws` is typed `void`, so the usual `assert.throws(...) as Error`
 * is a lie the compiler rightly rejects. This returns the error instead, which
 * is what a test actually wants: the message and the fields, not just the fact
 * that something was thrown.
 */
export function caught<T extends Error>(
  fn: () => unknown,
  type?: abstract new (...args: never[]) => T,
): T {
  try {
    fn();
  } catch (err) {
    if (type !== undefined && !(err instanceof type)) {
      assert.fail(`expected ${type.name}, got ${String(err)}`);
    }
    return err as T;
  }
  return assert.fail("expected the call to throw, but it returned");
}
