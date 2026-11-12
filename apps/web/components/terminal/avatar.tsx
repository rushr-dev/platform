import { useId } from 'react';

/**
 * Generated token avatar for tokens without an icon (or while the icon loads). Everything is
 * derived from the contract address, so a token always gets the same avatar on the server, in
 * the browser and across pages: a two-tone gradient from the Rushr palette, a faint mirrored
 * 5x5 pattern, and the ticker's first letter.
 */

/** [light, dark] stops, all from the terminal palette. */
const GRADIENTS: [string, string][] = [
  ['#36d42a', '#0b3a10'],
  ['#a6ff4d', '#1d5a14'],
  ['#5ec8ff', '#0f3550'],
  ['#ffb547', '#55300a'],
  ['#ff7ab6', '#4a1430'],
  ['#b58cff', '#2a1a4f'],
  ['#4de0c2', '#0d3d33'],
  ['#ff6b5b', '#4a1510'],
];

const byte = (hex: string, i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;

/** First letter or digit of the ticker (skips "$", emoji and punctuation). */
export function initialOf(symbol: string | null | undefined): string {
  const m = (symbol ?? '').match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
}

export function avatarSpec(address: string) {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0');
  const [from, to] = GRADIENTS[byte(hex, 0) % GRADIENTS.length]!;
  const angle = Math.round((byte(hex, 1) / 255) * 360);
  // 15 bits → a 5x5 grid mirrored around the middle column.
  const bits = (byte(hex, 2) << 16) | (byte(hex, 3) << 8) | byte(hex, 4);
  const cells: [number, number][] = [];
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 3; col++)
      if ((bits >> (row * 3 + col)) & 1) {
        cells.push([col, row]);
        if (col < 2) cells.push([4 - col, row]);
      }
  return { from, to, angle, cells };
}

export function GeneratedAvatar({
  address,
  symbol,
  size,
}: {
  address: string;
  symbol: string;
  size: number;
}) {
  const { from, to, angle, cells } = avatarSpec(address);
  // Unique per instance: a shared id breaks when the first copy sits in a display:none subtree.
  const id = `ga${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad) * 0.5;
  const y = Math.sin(rad) * 0.5;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="block rounded-full">
      <defs>
        <linearGradient id={id} x1={0.5 - x} y1={0.5 - y} x2={0.5 + x} y2={0.5 + y}>
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" fill={`url(#${id})`} />
      <g fill="#fff" opacity="0.11">
        {cells.map(([c, r]) => (
          <rect
            key={`${c}-${r}`}
            x={5 + c * 6.2}
            y={5 + r * 6.2}
            width="5.2"
            height="5.2"
            rx="1.2"
          />
        ))}
      </g>
      {/* Soft top-left sheen so it reads as a coin, not a flat sticker. */}
      <circle cx="13" cy="10" r="16" fill="#fff" opacity="0.07" />
      <circle cx="20" cy="20" r="19.5" fill="none" stroke="#fff" strokeOpacity="0.12" />
      <text
        x="20"
        y="20"
        dy="0.35em"
        textAnchor="middle"
        fontSize="18"
        fontWeight="700"
        fontFamily="var(--font-geist-sans), ui-sans-serif, system-ui"
        fill="#f4f8f2"
        style={{ paintOrder: 'stroke' }}
        stroke="rgba(5,7,6,0.35)"
        strokeWidth="1.5"
      >
        {initialOf(symbol)}
      </text>
    </svg>
  );
}
