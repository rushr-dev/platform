/* eslint-disable @next/next/no-img-element */

/**
 * Sketch art from public/art, served from pre-sized WebP files (`<name>-<width>.webp`).
 * Images are unoptimized on Cloudflare, so the browser picks a width from this srcset instead.
 * Fills its positioned parent, like next/image's `fill`.
 */
export function Art({
  name,
  widths,
  sizes,
  alt,
  className = '',
  priority = false,
}: {
  name: string;
  widths: number[];
  sizes: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const src = (w: number) => `/art/${name}-${w}.webp`;
  return (
    <img
      src={src(widths[widths.length - 1]!)}
      srcSet={widths.map((w) => `${src(w)} ${w}w`).join(', ')}
      sizes={sizes}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={`absolute inset-0 size-full ${className}`}
    />
  );
}
