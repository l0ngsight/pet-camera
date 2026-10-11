import { beforeEach, describe, expect, it } from 'vitest';
import { CloseCode, LIVENESS_TIMEOUT_MS, PING_INTERVAL_MS, type Role } from '../../src/shared/protocol';
import { createHub, type Conn } from '../../src/server/signaling';

class FakeConn implements Conn {
  sent: unknown[] = [];
  closed: { code: number; reason?: string } | null = null;
  terminated = false;
  readonly role: Role;
  constructor(role: Role) { this.role = role; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code: number, reason?: string) { this.closed = { code, reason }; }
  terminate() { this.terminated = true; }
  types() { return this.sent.map((m) => (m as { type: string }).type); }
}

const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } };
const answer = { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' } };
const cand = { type: 'candidate', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } };
const talk = { type: 'talk', audio: true, video: true };
const j = (v: unknown) => JSON.stringify(v);

let t: { now: number };
const mk = () => createHub({ now: () => t.now, log: () => {} });
beforeEach(() => { t = { now: 1_000_000 }; });

describe('presence', () => {
  it('tells a new client whether the counterpart is present', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    expect(v.sent).toEqual([{ type: 'peer', present: false }]);
    const s = new FakeConn('station');
    hub.connect(s);
    expect(s.sent).toEqual([{ type: 'peer', present: true }]);
    expect(v.sent.at(-1)).toEqual({ type: 'peer', present: true });
  });

  it('notifies the counterpart on disconnect', () => {
    const hub = mk();
    const v = new FakeConn('viewer'); const s = new FakeConn('station');
    hub.connect(s); hub.connect(v);
    s.sent.length = 0;
    hub.disconnect(v);
    expect(s.sent.at(-1)).toEqual({ type: 'peer', present: false });
    hub.disconnect(v); // idempotent
    expect(s.sent.filter((m) => (m as { present: boolean }).present === false)).toHaveLength(1);
  });
});

describe('relay matrix', () => {
  function pair() {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v);
    s.sent.length = 0; v.sent.length = 0;
    return { hub, s, v };
  }

  it('viewer -> station: offer, candidate, talk', () => {
    const { hub, s, v } = pair();
    for (const m of [offer, cand, talk]) hub.message(v, j(m));
    expect(s.sent).toEqual([offer, cand, talk]);
    expect(v.sent).toEqual([]);
  });

  it('station -> viewer: answer, candidate', () => {
    const { hub, s, v } = pair();
    for (const m of [answer, cand]) hub.message(s, j(m));
    expect(v.sent).toEqual([answer, cand]);
    expect(s.sent).toEqual([]);
  });

  it('re-serializes only validated fields', () => {
    const { hub, s, v } = pair();
    hub.message(v, j({ ...offer, evil: '<script>', sdp: { ...offer.sdp, x: 1 } }));
    expect(s.sent).toEqual([offer]);
  });

  it('drops silently when the counterpart is absent', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    hub.message(v, j(offer));
    expect(v.closed).toBeNull();
    expect(v.sent).toEqual([{ type: 'peer', present: false }]);
  });

  it('never relays pong', () => {
    const { hub, s, v } = pair();
    hub.message(v, j({ type: 'pong' }));
    expect(s.sent).toEqual([]);
  });
});

describe('invalid messages', () => {
  it.each([
    ['viewer', answer], ['station', offer], ['station', talk],
    ['viewer', { type: 'ping' }], ['viewer', { type: 'peer', present: true }],
    ['viewer', { type: 'bogus' }], ['viewer', 'not json'], ['viewer', { type: 'talk', audio: 'yes', video: false }],
  ] as const)('%s sending %j closes with 4400', (role, payload) => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v);
    const sender = role === 'viewer' ? v : s;
    const other = role === 'viewer' ? s : v;
    other.sent.length = 0;
    hub.message(sender, typeof payload === 'string' ? payload : j(payload));
    expect(sender.closed?.code).toBe(CloseCode.PROTOCOL_ERROR);
    expect(other.sent.filter((m) => (m as { type: string }).type !== 'peer')).toEqual([]);
    expect(other.sent.at(-1)).toEqual({ type: 'peer', present: false }); // sender is dropped immediately
  });

  it('closes with 4400 on message floods', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    for (let i = 0; i < 1000; i++) hub.message(v, j({ type: 'pong' }));
    expect(v.closed?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });
});

describe('replacement (newest wins)', () => {
  it('closes the old same-role socket with 4409 and re-announces to the counterpart', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v1 = new FakeConn('viewer'); const v2 = new FakeConn('viewer');
    hub.connect(s); hub.connect(v1);
    s.sent.length = 0;
    hub.connect(v2);
    expect(v1.closed?.code).toBe(CloseCode.REPLACED);
    expect(v2.sent).toEqual([{ type: 'peer', present: true }]);
    expect(s.sent).toEqual([{ type: 'peer', present: false }, { type: 'peer', present: true }]);
    // the old socket's close event must not disturb the new one
    s.sent.length = 0;
    hub.disconnect(v1);
    expect(s.sent).toEqual([]);
    hub.message(v2, j(offer));
    expect(s.sent).toEqual([offer]);
  });

  it('ignores messages from a replaced socket', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v1 = new FakeConn('viewer'); const v2 = new FakeConn('viewer');
    hub.connect(s); hub.connect(v1); hub.connect(v2);
    s.sent.length = 0;
    hub.message(v1, j(offer));
    expect(s.sent).toEqual([]);
  });

  it('replaces a station too', () => {
    const hub = mk();
    const s1 = new FakeConn('station'); const s2 = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(v); hub.connect(s1); v.sent.length = 0;
    hub.connect(s2);
    expect(s1.closed?.code).toBe(4409);
    expect(v.sent).toEqual([{ type: 'peer', present: false }, { type: 'peer', present: true }]);
  });
});

describe('liveness', () => {
  it('sends ping every 15 s and not more often', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    v.sent.length = 0;
    hub.tick();
    expect(v.types()).toEqual([]);
    t.now += PING_INTERVAL_MS;
    hub.tick();
    expect(v.types()).toEqual(['ping']);
    t.now += 5_000; hub.tick();
    expect(v.types()).toEqual(['ping']);
    t.now += 10_000; hub.tick();
    expect(v.types()).toEqual(['ping', 'ping']);
  });

  it('terminates a socket silent for more than 40 s and tells the counterpart', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v); s.sent.length = 0;
    for (let i = 0; i < 9; i++) { t.now += 5_000; hub.tick(); hub.message(s, j({ type: 'pong' })); }
    expect(v.terminated).toBe(true);
    expect(v.closed?.code).toBe(CloseCode.LIVENESS);
    expect(s.terminated).toBe(false);
    expect(s.sent.at(-1)).toEqual({ type: 'peer', present: false });
  });

  it('keeps a socket alive as long as it answers pings', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    for (let i = 0; i < 40; i++) { t.now += 5_000; hub.tick(); hub.message(v, j({ type: 'pong' })); }
    expect(v.terminated).toBe(false);
    expect(v.closed).toBeNull();
  });

  it('does not terminate right at the limit', () => {
    const hub = mk();
    const v = new FakeConn('viewer');
    hub.connect(v);
    t.now += LIVENESS_TIMEOUT_MS; hub.tick();
    expect(v.terminated).toBe(false);
    t.now += 1; hub.tick();
    expect(v.terminated).toBe(true);
  });
});

describe('shutdown', () => {
  it('closes everyone with 1001', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v);
    hub.shutdown();
    expect(s.closed?.code).toBe(1001);
    expect(v.closed?.code).toBe(1001);
  });
});

describe('revocation', () => {
  it('closes every socket with 4401 and frees both slots without peer chatter', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v);
    s.sent.length = 0; v.sent.length = 0;
    hub.revokeAll();
    expect(s.closed?.code).toBe(CloseCode.UNAUTHORIZED);
    expect(v.closed?.code).toBe(4401);
    expect(s.sent).toEqual([]);
    expect(v.sent).toEqual([]);
    // their close events are no-ops, and a fresh viewer finds nobody
    hub.disconnect(s); hub.disconnect(v);
    const v2 = new FakeConn('viewer');
    hub.connect(v2);
    expect(v2.sent).toEqual([{ type: 'peer', present: false }]);
  });

  it('ignores late messages from a revoked socket', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v); s.sent.length = 0;
    hub.revokeAll();
    hub.message(v, j(offer));
    expect(s.sent).toEqual([]);
  });
});

describe('send failures', () => {
  it('drops a connection whose send throws', () => {
    const hub = mk();
    const s = new FakeConn('station'); const v = new FakeConn('viewer');
    hub.connect(s); hub.connect(v);
    s.send = () => { throw new Error('boom'); };
    hub.message(v, j(offer));
    expect(s.terminated).toBe(true);
    expect(v.sent.at(-1)).toEqual({ type: 'peer', present: false });
  });
});
