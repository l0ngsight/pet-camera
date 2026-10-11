import type { Candidate, CandidateMsg } from '../../shared/protocol.js';

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
}

export function toCandidateMessage(candidate: RTCIceCandidate): CandidateMsg | null {
  if (!candidate.candidate) return null;
  const value: Candidate = {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
  return { type: 'candidate', candidate: value };
}

export class CandidateQueue {
  private readonly candidates: Candidate[] = [];

  async add(pc: RTCPeerConnection, candidate: Candidate): Promise<void> {
    if (!pc.remoteDescription) {
      this.candidates.push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  async flush(pc: RTCPeerConnection): Promise<void> {
    for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
  }

  clear(): void {
    this.candidates.length = 0;
  }
}
