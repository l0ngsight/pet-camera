import { describe, expect, it } from 'vitest';
import {
  MAX_CANDIDATE_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_SDP_CHARS,
  parseClientMessage,
  parseRole,
} from '../../src/shared/protocol';

const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } };
const answer = { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\n' } };
const candidate = {
  type: 'candidate',
  candidate: { candidate: 'candidate:1 1 udp 2122 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
};
const talk = { type: 'talk', audio: true, video: false };
const pong = { type: 'pong' };

const parse = (role: 'viewer' | 'station', v: unknown) =>
  parseClientMessage(role, typeof v === 'string' ? v : JSON.stringify(v));

describe('parseRole', () => {
  it('accepts station and viewer only', () => {
    expect(parseRole('station')).toBe('station');
    expect(parseRole('viewer')).toBe('viewer');
    for (const bad of ['', 'admin', 'Station', null, undefined, 'viewer,station']) {
      expect(parseRole(bad)).toBeNull();
    }
  });
});

describe('parseClientMessage', () => {
  it('accepts the messages each role may send', () => {
    expect(parse('viewer', offer)).toEqual({ ok: true, msg: offer });
    expect(parse('viewer', candidate)).toEqual({ ok: true, msg: candidate });
    expect(parse('viewer', talk)).toEqual({ ok: true, msg: talk });
    expect(parse('viewer', pong)).toEqual({ ok: true, msg: pong });
    expect(parse('station', answer)).toEqual({ ok: true, msg: answer });
    expect(parse('station', candidate)).toEqual({ ok: true, msg: candidate });
    expect(parse('station', pong)).toEqual({ ok: true, msg: pong });
  });

  it('rejects types not allowed for the sender role', () => {
    expect(parse('station', offer)).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(parse('station', talk)).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(parse('viewer', answer)).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('rejects server-only and unknown types', () => {
    for (const t of ['ping', 'peer', 'nope', '']) {
      expect(parse('viewer', { type: t, present: true })).toMatchObject({ ok: false });
    }
  });

  it('rejects non-JSON, non-objects and missing type', () => {
    for (const raw of ['not json', '[]', 'null', '42', '"str"', '{}', '{"type":5}']) {
      expect(parse('viewer', raw)).toMatchObject({ ok: false });
    }
  });

  it('rejects frames over the size limit', () => {
    const big = JSON.stringify({ type: 'pong', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    expect(parse('viewer', big)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('drops unknown fields (re-serializes only validated fields)', () => {
    const r = parse('viewer', { ...offer, evil: 1, sdp: { ...offer.sdp, extra: 'x' } });
    expect(r).toEqual({ ok: true, msg: offer });
    const t = parse('viewer', { ...talk, __proto__: { x: 1 }, extra: 1 });
    expect(t).toEqual({ ok: true, msg: talk });
  });

  it('validates SDP shape and size', () => {
    expect(parse('viewer', { type: 'offer', sdp: 'v=0' })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'offer', sdp: { type: 'answer', sdp: 'v=0' } })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'offer', sdp: { type: 'offer', sdp: 5 } })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'offer', sdp: { type: 'offer', sdp: '' } })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(MAX_SDP_CHARS) } })).toMatchObject({
      ok: true,
    });
    expect(parse('viewer', { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(MAX_SDP_CHARS + 1) } })).toMatchObject(
      { ok: false },
    );
  });

  it('validates candidates', () => {
    const c = (o: object) => ({ type: 'candidate', candidate: { ...candidate.candidate, ...o } });
    expect(parse('viewer', c({ sdpMid: null, sdpMLineIndex: null }))).toMatchObject({ ok: true });
    expect(parse('viewer', c({ candidate: 'x'.repeat(MAX_CANDIDATE_CHARS) }))).toMatchObject({ ok: true });
    expect(parse('viewer', c({ candidate: 'x'.repeat(MAX_CANDIDATE_CHARS + 1) }))).toMatchObject({ ok: false });
    expect(parse('viewer', c({ candidate: 5 }))).toMatchObject({ ok: false });
    expect(parse('viewer', c({ sdpMid: 5 }))).toMatchObject({ ok: false });
    expect(parse('viewer', c({ sdpMLineIndex: -1 }))).toMatchObject({ ok: false });
    expect(parse('viewer', c({ sdpMLineIndex: 1.5 }))).toMatchObject({ ok: false });
    expect(parse('viewer', c({ sdpMLineIndex: '0' }))).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'candidate', candidate: null })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'candidate', candidate: 'x' })).toMatchObject({ ok: false });
  });

  it('treats absent sdpMid / sdpMLineIndex as null', () => {
    const r = parse('viewer', { type: 'candidate', candidate: { candidate: 'a' } });
    expect(r).toEqual({ ok: true, msg: { type: 'candidate', candidate: { candidate: 'a', sdpMid: null, sdpMLineIndex: null } } });
  });

  it('requires boolean talk flags', () => {
    expect(parse('viewer', { type: 'talk', audio: 1, video: false })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'talk', audio: true })).toMatchObject({ ok: false });
    expect(parse('viewer', { type: 'talk', audio: 'true', video: 'false' })).toMatchObject({ ok: false });
  });

  it('accepts Buffer input', () => {
    expect(parseClientMessage('viewer', Buffer.from(JSON.stringify(pong)))).toEqual({ ok: true, msg: pong });
  });
});
