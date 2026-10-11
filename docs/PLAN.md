# PetCam — Plan

Owner: Dana (Dev Lead). Status: **DONE (2026-10-11)** — QA-approved (docs/QA_REPORT.md), security PASS (docs/SECURITY_REVIEW.md), clean checkout verified. Design: docs/ARCHITECTURE.md (v1, accepted). Contract: src/shared/protocol.ts.

## Goal
A TypeScript web app, self-hosted on the user's laptop, reachable over the home LAN/VPN from Chrome on Android/iOS phone:
- **(a) Monitor**: phone sees live video+audio from the laptop's camera/mic.
- **(b) Talk**: phone sends its own camera+mic to the laptop, which plays it full-screen with sound so the pets can see/hear the owner.

## Constraints
- TypeScript end to end (Node server + browser client). Node 24 available.
- Runs on the laptop; no cloud services, no accounts, no third-party relays. LAN only (VPN puts the phone on the LAN).
- Phone browsers only allow camera/mic (`getUserMedia`) in a **secure context** → server must serve **HTTPS** (self-signed cert generated locally, with instructions to trust it / click through).
- Laptop side runs in a browser tab ("station" page) so we reuse the browser's camera/WebRTC stack; must work unattended (auto-reconnect, wake lock where possible).
- Must be protected: anyone on the LAN must not be able to watch the camera. Shared secret/password, set by the user.
- Minimal dependencies; one-command start from a clean checkout (`npm install && npm start`).

## Definition of done
1. From a clean checkout following README: `npm install`, `npm start` → HTTPS server on the laptop; README explains cert trust + finding the LAN URL.
2. Laptop opens `/station`, authenticates, grants camera/mic; stays idle until a viewer connects; recovers after network drops/server restart.
3. Phone (Chrome, Android) opens `/`, authenticates, sees live laptop video+audio within ~3 s on LAN.
4. Phone taps "Talk" → laptop shows phone video and plays phone audio; "Mute/Stop talking" works; viewer can also do audio-only push-to-talk.
5. Unauthenticated requests cannot reach signaling or pages that stream media; secrets not committed; rate-limited login.
6. Unit tests for server (auth, signaling routing) + automated E2E (headless Chromium with fake media devices) pass via `npm test`.
7. QA sign-off; security findings ≥ medium fixed; README + user guide written.

## Decisions
- Accepted Ari's v1 design unchanged (viewer-only offers, no renegotiation, newest-wins 4409, signed stateless cookies, esbuild-only).
- Real-phone-over-VPN spike (ARCH §11 #1/#2) cannot be run by the team (no phone access); it becomes a **manual acceptance checklist for the user** in the README, with documented fallbacks (firewall rule, mkcert). Automated E2E covers everything else.

## Tickets
| ID | Owner | Scope | Acceptance criteria | Status |
|---|---|---|---|---|
| T1 | Ben | Scaffold: package.json (scripts per ARCH §4), tsconfigs, scripts/build.mjs, .env.example | `npm install && npm run build && npm run typecheck` clean from a clean checkout; build outputs dist/server + dist/public | done (228 unit tests) |
| T2 | Ben | config.ts, tls.ts, main.ts, set-password.ts (ARCH §5) | First run generates password (banner once), session secret, cert w/ LAN IPs in SAN (sha256), file modes 0600/0700; banner prints LAN URLs + fingerprint; set-password works; graceful shutdown | done (228 unit tests) |
| T3 | Ben | auth.ts + http.ts (ARCH §6) | All endpoints/status codes/headers exactly as §6 table; no fs access from request path; rate limit; unit tests | done (228 unit tests) |
| T4 | Ben | signaling.ts + `parse*` validators in protocol.ts (ARCH §7) | Pure hub; relay matrix, 4400, 4409, peer notifications, ping/pong liveness; unit tests with fake timers; `npm run test:unit` green | done (228 unit tests) |
| T5 | Fiona | client lib: signaling.ts, peer.ts (ARCH §8) | Backoff+jitter reconnect, session preflight, 401→login, 4409 no-reconnect, ICE queueing, failed/disconnected>5s re-offer | done |
| T6 | Fiona | Pages: login, viewer, station + styles (ARCH §6, §8) | Mobile-first viewer (watch, tap-for-sound, Talk, PTT hold, Stop, status), station (Start, wake lock, full-screen incoming video, track-ended recovery, sound-blocked overlay), `data-state` on root; no inline script/style (CSP) | done |
| T7 | Fiona | E2E (Playwright, ARCH §10) | All 6 §10 E2E assertions automated; `npm run test:setup && npm test` green | done (7 E2E, self-contained, free port) |
| T8 | Quinn | Test plan + verification | Runs clean-checkout flow per README, full `npm test`, exploratory tests (reconnect, server restart, replacement, bad input); sign-off or defects with repro | done — QA-APPROVED; D1 (sourcemaps) and D2 (=deferred L4 Host) waived |
| T9 | Sam | Security review | Design review now (ARCH §9); code review of auth/http/signaling/tls/config after T2–T4; findings with severity | done — PASS, 0 ≥medium; L7 (Fiona), L8 (Tess) being fixed |
| T10 | Tess | README + docs/USER_GUIDE.md | Install/run, cert trust (click-through + mkcert option), finding LAN URL, password mgmt, firewall/UDP, laptop power/lid, manual phone acceptance checklist, troubleshooting | done |

## Security design review (docs/SECURITY_REVIEW.md) — triage
Approved into scope: M1 (local CA signs leaf; public `GET /ca.crt`), M2 (watch config.json → reload + close WS with **4401**; clients go to login), M3 (count before scrypt, 1 in-flight/IP, global delay budget, async scrypt maxmem 64 MiB, min 12-char pw), L1 (station role + `/station` loopback-only, open via https://localhost:PORT/station), L2 (`__Host-petcam_session`), L3 (`npm run revoke-sessions` rotates sessionSecret via M2 path; strict exp parsing), L4 (Origin check on all non-GET), L5 (TTY prompt on first run, randomInt).
Dependency change (Ari, ARCH v1.1): `selfsigned` → `@peculiar/x509` (needed for name-constrained CA, M1); reference spike docs/spikes/local-ca.cjs. Sam to include in dependency audit.
Deferred: L4 Host→421 validation (risk of breaking mkcert/custom hostnames; Origin check covers the CSRF part).
Ben: T2/T3/T4 absorb these. Fiona: 4401 handling, localhost station URL hint, CA install link on login page. Tess: CA install guide.

**API contract** = ARCH §6 (HTTP) + §7 (WS) + `src/shared/protocol.ts`. Any change goes through Ari and gets announced to both engineers.
