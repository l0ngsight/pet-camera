import type { CandidateMsg, ServerToViewer } from '../shared/protocol.js';
import { $ } from './lib/dom.js';
import { CandidateQueue, createPeerConnection, toCandidateMessage } from './lib/peer.js';
import { SignalingClient, type SignalState } from './lib/signaling.js';

const root = $<HTMLElement>('#app');
const remoteVideo = $<HTMLVideoElement>('#pet-video');
const selfVideo = $<HTMLVideoElement>('#self-video');
const status = $<HTMLElement>('#status-label');
const stageHeading = $<HTMLElement>('#stage-heading');
const stageMessage = $<HTMLElement>('#stage-message');
const emptyState = $<HTMLElement>('#empty-state');
const talkHint = $<HTMLElement>('#talk-hint');
const talkButton = $<HTMLButtonElement>('#talk-button');
const pttButton = $<HTMLButtonElement>('#ptt-button');
const stopButton = $<HTMLButtonElement>('#stop-talk-button');
const soundButton = $<HTMLButtonElement>('#sound-button');
const reconnectButton = $<HTMLButtonElement>('#reconnect-button');

let signal: SignalingClient<'viewer'>;
let pc: RTCPeerConnection | null = null;
let remoteCandidateQueue = new CandidateQueue();
let candidatesBeforePeer: CandidateMsg['candidate'][] = [];
let peerPresent = false;
let outboundMode: 'none' | 'talk' | 'ptt' = 'none';
let phoneStream: MediaStream | null = null;
let audioSender: RTCRtpSender | null = null;
let videoSender: RTCRtpSender | null = null;
let disconnectTimer = 0;
let pttPointerActive = false;
let pttKeyActive = false;
let pttHeld = false;

function setState(state: 'connecting' | 'offline' | 'live' | 'talking', label: string): void {
  root.dataset.state = state;
  status.textContent = label;
  const connected = state === 'live' || state === 'talking';
  talkButton.disabled = !connected;
  pttButton.disabled = !connected;
  talkHint.textContent = connected ? 'Your pets can see and hear you.' : 'Your camera needs to be online before you can say hello.';
}

function setOfflineView(heading: string, message: string, state: 'connecting' | 'offline' = 'offline'): void {
  stageHeading.textContent = heading;
  stageMessage.textContent = message;
  emptyState.hidden = false;
  soundButton.hidden = true;
  setState(state, state === 'connecting' ? 'Connecting' : 'Station offline');
}

function resetTalkUi(): void {
  outboundMode = 'none';
  pttButton.setAttribute('aria-pressed', 'false');
  pttButton.textContent = '🎙 Push to talk';
  stopButton.hidden = true;
  selfVideo.hidden = true;
  selfVideo.srcObject = null;
}

async function releasePhoneTracks(): Promise<void> {
  const current = phoneStream;
  phoneStream = null;
  if (audioSender) await audioSender.replaceTrack(null).catch(() => undefined);
  if (videoSender) await videoSender.replaceTrack(null).catch(() => undefined);
  current?.getTracks().forEach((track) => track.stop());
  resetTalkUi();
  sendTalk(false, false);
  if (root.dataset.state === 'talking') setState(pc?.connectionState === 'connected' ? 'live' : 'connecting', pc?.connectionState === 'connected' ? 'Live' : 'Connecting');
}

function sendTalk(audio: boolean, video: boolean): void {
  signal?.send({ type: 'talk', audio, video });
}

async function closePeer(): Promise<void> {
  window.clearTimeout(disconnectTimer);
  remoteCandidateQueue.clear();
  candidatesBeforePeer = [];
  await releasePhoneTracks();
  const old = pc;
  pc = null;
  if (old) {
    old.ontrack = null;
    old.onicecandidate = null;
    old.onconnectionstatechange = null;
    old.close();
  }
  remoteVideo.srcObject = null;
  soundButton.hidden = true;
}

async function createViewerOffer(): Promise<void> {
  if (!peerPresent || !signal) return;
  await closePeer();
  const connection = createPeerConnection();
  pc = connection;
  for (const candidate of candidatesBeforePeer.splice(0)) void remoteCandidateQueue.add(connection, candidate);
  const audioTransceiver = connection.addTransceiver('audio', { direction: 'sendrecv' });
  const videoTransceiver = connection.addTransceiver('video', { direction: 'sendrecv' });
  audioSender = audioTransceiver.sender;
  videoSender = videoTransceiver.sender;
  connection.onicecandidate = (event) => {
    const candidate = event.candidate && toCandidateMessage(event.candidate);
    if (candidate) signal.send(candidate);
  };
  connection.ontrack = (event) => {
    if (pc !== connection) return;
    remoteVideo.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    emptyState.hidden = true;
    soundButton.hidden = false;
    void remoteVideo.play().catch(() => undefined);
  };
  connection.onconnectionstatechange = () => {
    if (pc !== connection) return;
    if (connection.connectionState === 'connected') {
      window.clearTimeout(disconnectTimer);
      setState(outboundMode === 'none' ? 'live' : 'talking', outboundMode === 'none' ? 'Live' : 'Talking');
      emptyState.hidden = true;
      return;
    }
    if (connection.connectionState === 'failed') {
      void createViewerOffer();
    } else if (connection.connectionState === 'disconnected') {
      window.clearTimeout(disconnectTimer);
      disconnectTimer = window.setTimeout(() => {
        if (pc === connection && connection.connectionState === 'disconnected') void createViewerOffer();
      }, 5_000);
    }
  };
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  if (connection.localDescription) signal.send({ type: 'offer', sdp: { type: 'offer', sdp: connection.localDescription.sdp ?? '' } });
  setState('connecting', 'Connecting to station');
  stageHeading.textContent = 'Connecting to your camera…';
  stageMessage.textContent = 'This usually takes just a moment.';
  emptyState.hidden = false;
}

async function handleMessage(message: ServerToViewer): Promise<void> {
  if (message.type === 'peer') {
    peerPresent = message.present;
    if (peerPresent) await createViewerOffer();
    else {
      await closePeer();
      const port = window.location.port ? `:${window.location.port}` : '';
      setOfflineView('Your station is offline', `On the laptop, open https://localhost${port}/station and start the camera.`);
      reconnectButton.hidden = false;
    }
  } else if (message.type === 'answer' && pc) {
    await pc.setRemoteDescription(message.sdp);
    await remoteCandidateQueue.flush(pc);
  } else if (message.type === 'candidate') {
    if (pc) await remoteCandidateQueue.add(pc, message.candidate);
    else candidatesBeforePeer.push(message.candidate);
  }
}

function onSignalState(state: SignalState, message?: string): void {
  if (state === 'connected') {
    reconnectButton.hidden = true;
    setState(peerPresent ? 'connecting' : 'offline', peerPresent ? 'Connecting to station' : 'Station offline');
  } else if (state === 'connecting') {
    void closePeer();
    peerPresent = false;
    setOfflineView('Reconnecting…', message ?? 'PetCam is reconnecting securely.', 'connecting');
    reconnectButton.hidden = true;
  } else if (state === 'replaced') {
    void closePeer();
    peerPresent = false;
    setOfflineView('Opened elsewhere', message ?? 'This viewer was replaced by another device.');
    reconnectButton.hidden = false;
    reconnectButton.textContent = 'Reconnect';
  } else if (state === 'unauthorized') {
    void closePeer();
    peerPresent = false;
  }
}

signal = new SignalingClient('viewer', { onMessage: (message) => void handleMessage(message), onState: onSignalState });
signal.start();

talkButton.addEventListener('click', async () => {
  if (!pc || !audioSender || !videoSender) return;
  try {
    await releasePhoneTracks();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
    phoneStream = stream;
    await audioSender.replaceTrack(stream.getAudioTracks()[0] ?? null);
    await videoSender.replaceTrack(stream.getVideoTracks()[0] ?? null);
    selfVideo.srcObject = stream;
    selfVideo.hidden = false;
    outboundMode = 'talk';
    stopButton.hidden = false;
    signal.send({ type: 'talk', audio: true, video: true });
    setState('talking', 'Talking');
  } catch {
    await releasePhoneTracks();
    talkHint.textContent = 'Allow camera and microphone access to talk to your pets.';
  }
});

async function startPushToTalk(): Promise<void> {
  if (!pc || !audioSender || pttButton.disabled) return;
  if (outboundMode !== 'ptt' || !phoneStream) {
    await releasePhoneTracks();
    try {
      phoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await audioSender.replaceTrack(phoneStream.getAudioTracks()[0] ?? null);
      outboundMode = 'ptt';
      stopButton.hidden = false;
    } catch {
      talkHint.textContent = 'Allow microphone access to use push to talk.';
      return;
    }
  }
  const track = phoneStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = pttHeld;
  pttButton.setAttribute('aria-pressed', String(pttHeld));
  pttButton.textContent = pttHeld ? '🎙 Release to mute' : '🎙 Push to talk';
  signal.send({ type: 'talk', audio: pttHeld, video: false });
  setState(pttHeld ? 'talking' : 'live', pttHeld ? 'Talking' : 'Live');
}

function stopPushToTalk(): void {
  if (outboundMode !== 'ptt' || !phoneStream) return;
  const track = phoneStream.getAudioTracks()[0];
  if (track) track.enabled = false;
  pttButton.setAttribute('aria-pressed', 'false');
  pttButton.textContent = '🎙 Push to talk';
  signal.send({ type: 'talk', audio: false, video: false });
  setState('live', 'Live');
}

pttButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  pttPointerActive = true;
  pttHeld = true;
  pttButton.setPointerCapture(event.pointerId);
  void startPushToTalk();
});
pttButton.addEventListener('pointerup', () => { pttPointerActive = false; pttHeld = pttKeyActive; stopPushToTalk(); });
pttButton.addEventListener('pointercancel', () => { pttPointerActive = false; pttHeld = pttKeyActive; stopPushToTalk(); });
pttButton.addEventListener('lostpointercapture', () => { if (pttPointerActive) { pttPointerActive = false; pttHeld = pttKeyActive; stopPushToTalk(); } });
pttButton.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !pttKeyActive) {
    event.preventDefault();
    pttKeyActive = true;
    pttHeld = true;
    void startPushToTalk();
  }
});
pttButton.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') {
    pttKeyActive = false;
    pttHeld = pttPointerActive;
    stopPushToTalk();
  }
});
pttButton.addEventListener('blur', () => { pttKeyActive = false; pttHeld = pttPointerActive; stopPushToTalk(); });
stopButton.addEventListener('click', () => void releasePhoneTracks());
soundButton.addEventListener('click', async () => {
  remoteVideo.muted = false;
  try { await remoteVideo.play(); soundButton.hidden = true; }
  catch { soundButton.hidden = false; }
});
reconnectButton.addEventListener('click', () => { reconnectButton.hidden = true; signal.reconnect(); });
window.addEventListener('pagehide', () => { signal.stop(); void releasePhoneTracks(); pc?.close(); });
