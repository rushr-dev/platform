/**
 * Sketch art from public/art, served from pre-sized files (`<name>-<width>.webp`, plus
 * `<name>-<width>.avif` when `avif` is set). Images are unoptimized on Cloudflare, so the
 * browser picks a width from the srcset instead. By default it fills its positioned parent,
 * like next/image's `fill`; pass `fill={false}` to position it yourself with `className`.
 */
export function Art({
  name,
  widths,
  sizes,
  alt,
  className = '',
  priority = false,
  avif = false,
  fill = true,
}: {
  name: string;
  widths: number[];
  sizes: string;
  alt: string;
  className?: string;
  priority?: boolean;
  avif?: boolean;
  fill?: boolean;
}) {
  const set = (ext: string) => widths.map((w) => `/art/${name}-${w}.${ext} ${w}w`).join(', ');
  const img = (
    <img
      src={`/art/${name}-${widths[widths.length - 1]!}.webp`}
      srcSet={set('webp')}
      sizes={sizes}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={`${fill ? 'absolute inset-0 size-full' : ''} ${className}`}
    />
  );
  if (!avif) return img;
  return (
    <picture>
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      {img}
    </picture>
  );
}
