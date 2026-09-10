import { BrpPrecisionError } from './errors.js';

/**
 * Reject any decoded JSON integer that is not a safe JavaScript integer
 * (64-bit entity ids and component integers), naming the method and the
 * value path. Floats are untouched. Shared by instant BRP calls (throws) and
 * the SSE watch parser so streams cannot become the precision loophole.
 */
export function assertSafeIntegers(value: unknown, method: string, path: string): void {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new BrpPrecisionError(method, path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeIntegers(item, method, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertSafeIntegers(item, method, `${path}.${key}`);
    }
  }
}
