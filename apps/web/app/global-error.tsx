'use client';

import { ErrorScreen } from '@/components/error-screen';

/** Errors in the root layout itself. Next renders this without the layout, so it brings its own html/body. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <ErrorScreen error={error} />
      </body>
    </html>
  );
}
