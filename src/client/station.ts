import type { CandidateMsg, ServerToStation, TalkMsg } from '../shared/protocol.js';
import { $ } from './lib/dom.js';
import { CandidateQueue, createPeerConnection, toCandidateMessage } from './lib/peer.js';
import { SignalingClient, type SignalState } from './lib/signaling.js';

const root = $<HTMLElement>('#app');
const localVideo = $<HTMLVideoElement>('#pet-video');
const ownerVideo = $<HTMLVideoElement>('#owner-video');
const ownerAudio = $<HTMLAudioElement>('#owner-audio');
const placeholder = $<HTMLElement>('#station-placeholder');
const stationMessage = $<HTMLElement>('#station-message');
const status = $<HTMLElement>('#status-label');
const talkBanner = $<HTMLElement>('#talk-banner');
const soundBlocked = $<HTMLElement>('#sound-blocked');
const startButton = $<HTMLButtonElement>('#start-button');
const stopButton = $<HTMLButtonElement>('#stop-button');
const soundButton = $<HTMLButtonElement>('#enable-sound-button');

let signal: SignalingClient<'station'> | null = null;
let pc: RTCPeerConnection | null = null;
let remoteCandidateQueue = new CandidateQueue();
let candidatesBeforePeer: CandidateMsg['candidate'][] = [];
let localStream: MediaStream | null = null;
let wakeLock: WakeLockSentinel | null = null;
let stationStarted = false;
let talkAudio = false;
let talkVideo = false;
let remoteStream: MediaStream | null = null;
let wakeLockSupported = false;
let unlockAudioContext: AudioContext | null = null;

function setState(state: 'connecting' | 'offline' | 'live' | 'talking', label: string): void {
  root.dataset.state = state;
  status.textContent = label;
}

function renderTalkState(): void {
  const showingOwner = talkAudio || talkVideo;
  ownerVideo.hidden = !talkVideo || !remoteStream;
  ownerVideo.muted = true;
  ownerAudio.srcObject = remoteStream;
  ownerAudio.muted = !talkAudio;
  talkBanner.hidden = !showingOwner;
  const state = showingOwner ? 'talking' : pc?.connectionState === 'connected' ? 'live' : 'connecting';
  setState(state, showingOwner ? 'Your person is talking' : state === 'live' ? 'Camera live' : 'Connecting');
  if (showingOwner) {
    void ownerAudio.play().catch(() => {
      stationMessage.textContent = 'Click Start station again to enable sound from your phone.';
      stationMessage.hidden = false;
      placeholder.hidden = false;
      soundBlocked.hidden = false;
      soundButton.hidden = false;
    });
    if (talkVideo) void ownerVideo.play().catch(() => undefined);
  }
}

async function acquireWakeLock(): Promise<void> {
  if (!wakeLockSupported || document.visibilityState !== 'visible' || wakeLock) return;
  try { wakeLock = await navigator.wakeLock!.request('screen'); }
  catch { /* Wake lock is best-effort and may be denied by the browser. */ }
  wakeLock?.addEventListener('release', () => { wakeLock = null; });
}

async function stopPeer(): Promise<void> {
  talkAudio = false;
  talkVideo = false;
  remoteStream = null;
  remoteCandidateQueue.clear();
  candidatesBeforePeer = [];
  const old = pc;
  pc = null;
  if (old) {
    old.ontrack = null;
    old.onicecandidate = null;
    old.onconnectionstatechange = null;
    old.close();
  }
  ownerVideo.srcObject = null;
  ownerAudio.srcObject = null;
  ownerAudio.muted = true;
  soundBlocked.hidden = true;
  talkBanner.hidden = true;
  ownerVideo.hidden = true;
}

async function handleOffer(offer: Extract<ServerToStation, { type: 'offer' }>): Promise<void> {
  if (!localStream || !signal) return;
  await stopPeer();
  const connection = createPeerConnection();
  pc = connection;
  for (const candidate of candidatesBeforePeer.splice(0)) void remoteCandidateQueue.add(connection, candidate);
  connection.onicecandidate = (event) => {
    const candidate = event.candidate && toCandidateMessage(event.candidate);
    if (candidate) signal?.send(candidate);
  };
  connection.ontrack = (event) => {
    if (pc !== connection) return;
    remoteStream = event.streams[0] ?? new MediaStream([event.track]);
    ownerVideo.srcObject = remoteStream;
    ownerAudio.srcObject = remoteStream;
    renderTalkState();
  };
  connection.onconnectionstatechange = () => {
    if (pc !== connection) return;
    if (connection.connectionState === 'connected') {
      placeholder.hidden = true;
      if (!talkAudio && !talkVideo) setState('live', 'Camera live');
    } else if (connection.connectionState === 'failed') {
      void stopPeer();
      setState('connecting', 'Reconnecting to viewer');
    } else if (connection.connectionState === 'disconnected') {
      setState('connecting', 'Network interrupted');
    }
  };
  try {
    await connection.setRemoteDescription(offer.sdp);
    for (const track of localStream.getTracks()) connection.addTrack(track, localStream);
    await remoteCandidateQueue.flush(connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (connection.localDescription) signal.send({ type: 'answer', sdp: { type: 'answer', sdp: connection.localDescription.sdp ?? '' } });
    placeholder.hidden = true;
  } catch {
    await stopPeer();
    stationMessage.textContent = 'Couldn’t connect to the viewer. Waiting for a new connection…';
    placeholder.hidden = false;
    setState('connecting', 'Waiting for viewer');
  }
}

async function handleMessage(message: ServerToStation): Promise<void> {
  if (message.type === 'peer') {
    if (message.present) {
      stationMessage.textContent = 'Phone connected. Starting the live view…';
      placeholder.hidden = false;
      setState('connecting', 'Phone connected');
    } else {
      await stopPeer();
      if (stationStarted) {
        placeholder.hidden = false;
        stationMessage.textContent = 'Camera is ready. Waiting for your phone to connect.';
        setState('offline', 'Idle');
      }
    }
  } else if (message.type === 'offer') {
    await handleOffer(message);
  } else if (message.type === 'candidate') {
    if (pc) await remoteCandidateQueue.add(pc, message.candidate);
    else candidatesBeforePeer.push(message.candidate);
  } else if (message.type === 'talk') {
    talkAudio = message.audio;
    talkVideo = message.video;
    renderTalkState();
  }
}

function onSignalState(state: SignalState, message?: string): void {
  if (state === 'connected') {
    placeholder.hidden = false;
    stationMessage.textContent = 'Camera is ready. Waiting for your phone to connect.';
    setState('offline', 'Idle');
  } else if (state === 'connecting') {
    void stopPeer();
    if (stationStarted) {
      stationMessage.textContent = message ?? 'Trying to reconnect…';
      placeholder.hidden = false;
      setState('connecting', 'Reconnecting');
    }
  } else if (state === 'replaced') {
    void stopPeer();
    const replacementMessage = message ?? 'This station was opened in another tab.';
    void stopStation().then(() => {
      stationMessage.textContent = replacementMessage;
      placeholder.hidden = false;
      setState('offline', 'Opened elsewhere');
    });
  } else if (state === 'unauthorized') {
    void stopStation();
  }
}

async function startStation(): Promise<void> {
  if (stationStarted) return;
  startButton.disabled = true;
  stationMessage.textContent = 'Allow camera and microphone access to start your station.';
  try {
    // Start a silent media stream directly in the click gesture. Later incoming
    // owner audio can replace it without Chrome blocking unattended playback.
    unlockAudioContext = new AudioContext();
    const destination = unlockAudioContext.createMediaStreamDestination();
    const silentGain = unlockAudioContext.createGain();
    silentGain.gain.value = 0;
    const oscillator = unlockAudioContext.createOscillator();
    oscillator.connect(silentGain).connect(destination);
    oscillator.start();
    ownerAudio.srcObject = destination.stream;
    ownerAudio.muted = false;
    void unlockAudioContext.resume().catch(() => undefined);
    void ownerAudio.play().catch(() => undefined);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
    localStream = stream;
    localVideo.srcObject = stream;
    await localVideo.play().catch(() => undefined);
    stationStarted = true;
    startButton.hidden = true;
    startButton.disabled = false;
    stopButton.hidden = false;
    placeholder.hidden = false;
    stationMessage.textContent = 'Camera is ready. Waiting for your phone to connect.';
    setState('connecting', 'Connecting');
    signal = new SignalingClient('station', { onMessage: (message) => void handleMessage(message), onState: onSignalState });
    signal.start();
    await acquireWakeLock();
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => { if (track.kind === 'video') void replaceCameraAfterDeviceChange(); }, { once: true });
    }
  } catch {
    startButton.disabled = false;
    stationMessage.textContent = 'Camera or microphone access is blocked. Check browser permissions and try again.';
    setState('offline', 'Camera access needed');
  }
}

async function replaceCameraAfterDeviceChange(): Promise<void> {
  try {
    const replacement = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
    const oldStream = localStream;
    localStream = replacement;
    localVideo.srcObject = replacement;
    const videoTrack = replacement.getVideoTracks()[0] ?? null;
    const audioTrack = replacement.getAudioTracks()[0] ?? null;
    for (const sender of pc?.getSenders() ?? []) {
      if (sender.track?.kind === 'video') await sender.replaceTrack(videoTrack);
      if (sender.track?.kind === 'audio') await sender.replaceTrack(audioTrack);
    }
    oldStream?.getTracks().forEach((track) => track.stop());
    for (const track of replacement.getTracks()) {
      track.addEventListener('ended', () => { if (track.kind === 'video') void replaceCameraAfterDeviceChange(); }, { once: true });
    }
  } catch {
    stationMessage.textContent = 'Camera disconnected. Reconnect it, then use Stop and Start station.';
    placeholder.hidden = false;
  }
}

async function stopStation(): Promise<void> {
  signal?.stop();
  signal = null;
  await stopPeer();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
  stationStarted = false;
  wakeLock?.release();
  wakeLock = null;
  void unlockAudioContext?.close();
  unlockAudioContext = null;
  startButton.hidden = false;
  startButton.disabled = false;
  stopButton.hidden = true;
  placeholder.hidden = false;
  stationMessage.textContent = 'Start your station to connect the camera and microphone.';
  setState('offline', 'Idle');
}

startButton.addEventListener('click', () => void startStation());
stopButton.addEventListener('click', () => void stopStation());
soundButton.addEventListener('click', async () => {
  ownerAudio.muted = !talkAudio;
  try {
    await ownerAudio.play();
    soundBlocked.hidden = true;
    soundButton.hidden = true;
    if (talkAudio) placeholder.hidden = true;
  } catch {
    stationMessage.textContent = 'Sound is still blocked. Check this tab’s audio settings and try again.';
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void acquireWakeLock(); });
wakeLockSupported = 'wakeLock' in navigator;
window.addEventListener('pagehide', () => { signal?.stop(); pc?.close(); localStream?.getTracks().forEach((track) => track.stop()); wakeLock?.release(); void unlockAudioContext?.close(); });
