import { decodeErrorResult, type Address, type Hex } from 'viem';
import { knownErrorsAbi } from './abis.ts';

/** Human-readable revert reason from revert data (unwraps Universal Router ExecutionFailed). */
export function decodeRevert(data: Hex | undefined, depth = 0): string {
  if (!data || data === '0x') return 'execution reverted (no reason)';
  try {
    const e = decodeErrorResult({ abi: knownErrorsAbi, data });
    if (e.errorName === 'ExecutionFailed' && depth < 3) {
      const [index, message] = e.args as readonly [bigint, Hex];
      return `command ${index} failed: ${decodeRevert(message, depth + 1)}`;
    }
    if (e.errorName === 'WrappedError' && depth < 3) {
      const [target, , reason] = e.args as readonly [Address, Hex, Hex, Hex];
      return `${target.slice(0, 10)}… reverted: ${decodeRevert(reason, depth + 1)}`;
    }
    if (e.errorName === 'UnexpectedRevertBytes' && depth < 3) return decodeRevert((e.args as readonly [Hex])[0], depth + 1);
    const args = (e.args ?? []).map((a) => String(a)).join(', ');
    return `${e.errorName}(${args})`;
  } catch {
    return `revert ${data.slice(0, 10)}`;
  }
}

