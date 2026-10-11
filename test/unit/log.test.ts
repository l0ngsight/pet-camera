import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/server/log';

describe('createLogger', () => {
  it('writes one JSON object per line with level, msg and fields', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => new Date('2026-01-01T00:00:00Z'));
    log('info', 'started', { port: 8443 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'started', port: 8443 });
  });

  it('does not let fields overwrite the core keys', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l))('warn', 'real', { msg: 'fake', level: 'x' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'real' });
  });
});
