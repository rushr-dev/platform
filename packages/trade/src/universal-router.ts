import { concatHex, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, toHex, type Address, type Hex } from 'viem';

/**
 * Minimal, typed encoder for Uniswap Universal Router v2 commands and v4 router actions.
 * Command and action ids follow universal-router/contracts/libraries/Commands.sol and
 * v4-periphery/src/libraries/Actions.sol.
 */
export const Command = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
} as const;
export type CommandId = (typeof Command)[keyof typeof Command];

/** Set on a command byte to let the router continue if that command reverts. Never used for fee commands. */
export const ALLOW_REVERT = 0x80;

export const V4Action = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
} as const;

/** ActionConstants.OPEN_DELTA: settle/take the full open delta. */
export const OPEN_DELTA = 0n;
/** ActionConstants.CONTRACT_BALANCE: use the router's whole balance as the amount. */
export const CONTRACT_BALANCE = 1n << 255n;

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function execute(bytes commands, bytes[] inputs) payable',
]);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const POOL_KEY = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;

export interface EncodedCommand {
  command: number;
  input: Hex;
  /** Human-readable, for the UI's "route" disclosure and for tests. */
  label: string;
}

export const cmd = {
  wrapEth(recipient: Address, amountMin: bigint): EncodedCommand {
    return { command: Command.WRAP_ETH, input: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amountMin]), label: 'WRAP_ETH' };
  },
  unwrapWeth(recipient: Address, amountMin: bigint): EncodedCommand {
    return { command: Command.UNWRAP_WETH, input: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amountMin]), label: 'UNWRAP_WETH' };
  },
  /** Fixed-amount transfer from the router's balance (used for the buy-side fee). */
  transfer(token: Address, recipient: Address, value: bigint): EncodedCommand {
    return { command: Command.TRANSFER, input: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, recipient, value]), label: 'TRANSFER' };
  },
  /** Pays bips/10_000 of the router's balance of `token` (used for the sell-side fee). */
  payPortion(token: Address, recipient: Address, bips: number): EncodedCommand {
    return { command: Command.PAY_PORTION, input: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, recipient, BigInt(bips)]), label: 'PAY_PORTION' };
  },
  /** Pull `amount` of an ERC20 from msg.sender to recipient through Permit2 (USDG buy-side fee). */
  permit2TransferFrom(token: Address, recipient: Address, amount: bigint): EncodedCommand {
    return { command: Command.PERMIT2_TRANSFER_FROM, input: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], [token, recipient, amount]), label: 'PERMIT2_TRANSFER_FROM' };
  },
  sweep(token: Address, recipient: Address, amountMin: bigint): EncodedCommand {
    return { command: Command.SWEEP, input: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, recipient, amountMin]), label: 'SWEEP' };
  },
  /**
   * Universal Router v2.1 appends `uint256[] maxHopSlippage` (per-hop price checks) to the v2/v3 swap
   * inputs; we pass an empty array. Matches the 320-byte inputs of live v3 swaps on 4663 (2026-11-12);
   * the 5-field v2.0 layout reverts with SliceOutOfBounds on both deployed routers.
   */
  v3SwapExactIn(recipient: Address, amountIn: bigint, amountOutMin: bigint, path: Hex, payerIsUser: boolean, maxHopSlippage: bigint[] = []): EncodedCommand {
    return {
      command: Command.V3_SWAP_EXACT_IN,
      input: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
        [recipient, amountIn, amountOutMin, path, payerIsUser, maxHopSlippage],
      ),
      label: 'V3_SWAP_EXACT_IN',
    };
  },
  v2SwapExactIn(recipient: Address, amountIn: bigint, amountOutMin: bigint, path: Address[], payerIsUser: boolean, maxHopSlippage: bigint[] = []): EncodedCommand {
    return {
      command: Command.V2_SWAP_EXACT_IN,
      input: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }, { type: 'uint256[]' }],
        [recipient, amountIn, amountOutMin, path, payerIsUser, maxHopSlippage],
      ),
      label: 'V2_SWAP_EXACT_IN',
    };
  },
  permit2Permit(permit: PermitSingle, signature: Hex): EncodedCommand {
    return {
      command: Command.PERMIT2_PERMIT,
      input: encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'details', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
              { name: 'spender', type: 'address' },
              { name: 'sigDeadline', type: 'uint256' },
            ],
          },
          { type: 'bytes' },
        ],
        [permit, signature],
      ),
      label: 'PERMIT2_PERMIT',
    };
  },
  v4Swap(actions: V4Step[]): EncodedCommand {
    const actionBytes = concatHex(actions.map((a) => toHex(a.action, { size: 1 })));
    return {
      command: Command.V4_SWAP,
      input: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actionBytes, actions.map((a) => a.params)]),
      label: `V4_SWAP(${actions.map((a) => a.label).join(',')})`,
    };
  },
};

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

export interface V4Step {
  action: number;
  params: Hex;
  label: string;
}

export const v4 = {
  /**
   * The routers on 4663 use the newer v4-periphery ExactInputSingleParams with a per-hop slippage word
   * before hookData (0 = off). Live SWAP_EXACT_IN_SINGLE params are 384 bytes (checked 2026-11-12); the
   * old 5-field layout misreads the hookData offset as that word and reverts on some pools.
   */
  swapExactInSingle(p: { poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; maxHopSlippage?: bigint; hookData?: Hex }): V4Step {
    return {
      action: V4Action.SWAP_EXACT_IN_SINGLE,
      params: encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'poolKey', ...POOL_KEY },
              { name: 'zeroForOne', type: 'bool' },
              { name: 'amountIn', type: 'uint128' },
              { name: 'amountOutMinimum', type: 'uint128' },
              { name: 'maxHopSlippage', type: 'uint256' },
              { name: 'hookData', type: 'bytes' },
            ],
          },
        ],
        [{ poolKey: p.poolKey, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, maxHopSlippage: p.maxHopSlippage ?? 0n, hookData: p.hookData ?? '0x' }],
      ),
      label: 'SWAP_EXACT_IN_SINGLE',
    };
  },
  /** Pay `amount` of currency to the PoolManager; payerIsUser=false pays from the router's balance. */
  settle(currency: Address, amount: bigint, payerIsUser: boolean): V4Step {
    return { action: V4Action.SETTLE, params: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currency, amount, payerIsUser]), label: 'SETTLE' };
  },
  /** Pay the full debt in currency from msg.sender (via Permit2 for ERC20s), at most maxAmount. */
  settleAll(currency: Address, maxAmount: bigint): V4Step {
    return { action: V4Action.SETTLE_ALL, params: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, maxAmount]), label: 'SETTLE_ALL' };
  },
  /** Take `amount` (0 = full open delta) of currency to recipient (UR_ADDRESS_THIS keeps it in the router). */
  take(currency: Address, recipient: Address, amount: bigint): V4Step {
    return { action: V4Action.TAKE, params: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency, recipient, amount]), label: 'TAKE' };
  },
  /** Take the full credit in currency to msg.sender, reverting below minAmount. */
  takeAll(currency: Address, minAmount: bigint): V4Step {
    return { action: V4Action.TAKE_ALL, params: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, minAmount]), label: 'TAKE_ALL' };
  },
};

/** v3 path: token (20) | fee (3) | token (20) ... */
export function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1 || tokens.length < 2) throw new Error('v3 path: tokens.length must be fees.length + 1');
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  tokens.forEach((t, i) => {
    types.push('address');
    values.push(t);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]!);
    }
  });
  return encodePacked(types, values);
}

export interface RouterPlan {
  commands: EncodedCommand[];
}

export function encodeExecute(commands: EncodedCommand[], deadline: bigint): Hex {
  const bytes = concatHex(commands.map((c) => toHex(c.command, { size: 1 })));
  return encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [bytes, commands.map((c) => c.input), deadline] });
}

export function describeCommands(commands: EncodedCommand[]): string[] {
  return commands.map((c) => c.label);
}
