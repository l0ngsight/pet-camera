/** Login redirect target: exactly `/` or `/station`, anything else becomes `/` (no open redirect). */
export function sanitizeNext(next: string | null | undefined): '/' | '/station' {
  return next === '/station' ? '/station' : '/';
}
