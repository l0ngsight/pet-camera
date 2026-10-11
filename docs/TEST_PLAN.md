# PetCam — Test Plan

Owner: Quinn (QA Engineer). Status: **Draft for review**. Based on ARCHITECTURE.md v1, PLAN.md tickets T1–T7, and Security Design Review (PLAN.md § "Security design review").

---

## 1. Purpose

This plan defines how we verify that PetCam meets the acceptance criteria in PLAN.md § "Definition of done" and the contracts in ARCHITECTURE.md §§6–8. It covers:

- **Clean-checkout run** per the README (T8 scope).
- **Automated E2E** (already defined in ARCH §10; run via `npm test`).
- **Manual / exploratory cases** that automation cannot or should not cover.
- **Real-phone acceptance checklist** from ARCH §11 for the end user.

All browser testing uses **headless Playwright Chromium with a temporary profile** (via `PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright`). No user browser is touched. No processes not started by the test runner are killed.

---

## 2. Prerequisites

- Node ≥ 24 installed.
- Clean checkout of the repository (no `data/`, `dist/`, `node_modules/`, `.env`, `.cache/`).
- Linux/macOS host for the server (the laptop). Windows is not a target.
- For manual phone tests: an Android phone with Chrome, connected to the same LAN or to the home VPN.

---

## 3. Clean-Checkout Verification (Smoke Test)

**Goal**: Confirm the README "one-command start" works from a truly clean state.

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | `rm -rf data dist node_modules .cache .env` | Clean working tree. |
| 3.2 | `npm install` | Installs without errors; `node_modules/` populated. |
| 3.3 | `npm run build` | Produces `dist/server/main.js`, `dist/server/set-password.js`, `dist/public/assets/*.js`, `dist/public/pages/*.html`, `dist/public/assets/styles.css`. |
| 3.4 | `npm start` (background) | Server starts on `https://0.0.0.0:8443` (or `PETCAM_PORT`). Banner prints:<br/>- Generated password (first run only).<br/>- LAN URLs with HTTPS (e.g. `https://192.168.1.42:8443/`).<br/>- SHA-256 cert fingerprint. |
| 3.5 | Open `https://<LAN_IP>:8443/` in headless Playwright Chromium (ignore HTTPS errors). | Login page loads; CSP headers present; no console errors. |
| 3.6 | Enter the printed password, submit. | Redirects to `/` (viewer); `Set-Cookie: __Host-petcam_session=…; HttpOnly; Secure; SameSite=Strict; Path=/`. |
| 3.7 | Open `https://<LAN_IP>:8443/station` in a second context. | Redirects to `/login?next=/station`; after login, shows station page with "Start station" button. |
| 3.8 | Click "Start station", grant fake media (Playwright flags). | Station shows `data-state="live"` or `connecting`; viewer shows `data-state="live"` within 5 s. |
| 3.9 | Stop server (`SIGINT`). | Server logs graceful shutdown (closes WS with 1001). |
| 3.10 | Restart server (`npm start`). | No new password banner; existing sessions valid (cookie survives restart). |

**Pass criteria**: All steps complete without manual intervention beyond step 3.4 (Playwright ignores cert errors for automated tests; real users must install the CA or use mkcert — never click through).

---

## 4. Automated E2E (Reference)

Run via `npm run test:setup && npm run test:e2e` (or `npm test` for the full suite). Playwright config uses:

- `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`
- `ignoreHTTPSErrors: true`
- Random free port, temporary `PETCAM_DATA_DIR`, `PETCAM_PASSWORD=test-password-123`
- Two isolated browser contexts (station + viewer)

**Assertions (ARCH §10)**:
1. Viewer inbound video `framesDecoded` increases within 5 s.
2. After Talk, station inbound video increases.
3. PTT produces inbound audio on station.
4. Server restart → both reconnect and video resumes.
5. Unauthenticated WS and pages are rejected (401/302).
6. Second viewer replaces first with WS close code 4409.

**Note**: These are **not** redefined here. The QA run executes them and records pass/fail in QA_REPORT.md.

---

## 5. Manual / Exploratory Test Cases

These cases exercise failure paths, edge conditions, and security boundaries that the automated suite does not cover (or covers only superficially). Each case is run **manually** by the QA engineer using Playwright scripts, `curl`, `wscat`, or a browser devtools console. All server processes are started and stopped by the test runner.

### 5.1 Server Restart & Session Survival

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.1.1 | Graceful restart (SIGINT) with active viewer+station | 1. Start server, login both roles, establish live video.<br>2. Send `SIGINT` to server process.<br>3. Restart server (`npm start`).<br>4. Observe both clients. | Both clients reconnect (backoff+jitter), `/api/session` returns 200 with refreshed cookie, video resumes within ~10 s. No "Opened elsewhere" shown. |
| 5.1.2 | Hard kill (SIGKILL) then restart | 1. Live session.<br>2. `kill -9 <pid>`.<br>3. Restart server. | Same as 5.1.1; clients detect missing pings (40 s timeout), close sockets, reconnect. |
| 5.1.3 | Cert regeneration on IP change | 1. Start server, note cert fingerprint.<br>2. Change laptop LAN IP (or add a dummy interface).<br>3. Restart server. | New cert generated with new IP in SAN; banner prints new fingerprint; old sessions still valid (session secret unchanged). |
| 5.1.4 | Config directory permissions | 1. `ls -la data/` after first start. | `data/` mode 0700; `data/config.json` and `data/tls/*.pem` mode 0600. |

### 5.2 WebSocket Drop & Reconnect

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.2.1 | Network partition (viewer) | 1. Live session.<br>2. Block viewer's outbound traffic to server port (e.g. `nft`/`iptables` DROP).<br>3. Wait 50 s.<br>4. Unblock. | Viewer: `peer{present:false}` → "Station offline" UI. After unblock: reconnects (backoff), `peer{present:true}`, new offer, video resumes. |
| 5.2.2 | Network partition (station) | Same, but block station. | Station: `peer{present:false}` → "Idle". Viewer: `peer{present:false}` → "Station offline". Both recover after unblock. |
| 5.2.3 | Wi-Fi handoff (phone switches AP) | 1. Live session on phone.<br>2. Switch phone to a different AP on same LAN (or toggle VPN).<br>3. Observe. | Viewer gets new IP → new WS connection → server sends 4409 to old socket → old socket shows "Opened elsewhere – Reconnect" (no auto-reconnect). New socket establishes, video resumes. |
| 5.2.4 | Liveness timeout (no ping) | 1. Live session.<br>2. On server, patch `PING_INTERVAL_MS` to a large value (or block server→client pings).<br>3. Wait 45 s. | Client closes socket (no ping for 40 s), reconnects, session preflight (`/api/session`) succeeds, video resumes. |
| 5.2.5 | Server stops sending pings (code change) | 1. Modify `signaling.ts` to stop ping timer.<br>2. Rebuild, restart server with live clients. | Clients detect missing pings after 40 s, reconnect. |

### 5.3 4409 REPLACED (Newest-Wins)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.3.1 | Second viewer connects | 1. Viewer A live.<br>2. Open second browser context (Viewer B), login, connect WS. | Viewer A receives WS close 4409, shows "Opened elsewhere – Reconnect" button, **does not auto-reconnect**. Viewer B becomes active, video plays. |
| 5.3.2 | Second station connects | 1. Station live.<br>2. Open second station tab, login, connect WS. | Station A receives 4409, shows "Opened elsewhere", stops. Station B takes over camera/mic. |
| 5.3.3 | Viewer reconnects after 4409 | After 5.3.1, click "Reconnect" on Viewer A. | Viewer A becomes active, Viewer B gets 4409. Ping-pong prevented by "no auto-reconnect on 4409". |
| 5.3.4 | 4409 with expired session | 1. Viewer A live.<br>2. Expire Viewer A's cookie (edit `expSec` in cookie to past).<br>3. Viewer B connects. | Viewer A gets 4409 (replacement happens before auth re-check on existing socket). Viewer B gets 401 on `/api/session` preflight → redirected to login. |

### 5.4 Bad Login & Rate Limiting

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.4.1 | Wrong password | POST `/api/login` with bad password. | 401 `{"error":"invalid_password"}`. No cookie set. |
| 5.4.2 | Empty password | POST `/api/login` with `{"password":""}`. | 401 (scrypt verify fails). |
| 5.4.3 | Missing password field | POST `/api/login` with `{}`. | 400 `{"error":"bad_request"}`. |
| 5.4.4 | Non-JSON body | POST `/api/login` with `password=foo` (form) or plain text. | 415 if wrong Content-Type; 400 if JSON but invalid. |
| 5.4.5 | Oversized body (>1 KB) | POST `/api/login` with `{"password":"x".repeat(2000)}`. | 400 `{"error":"bad_request"}`. |
| 5.4.6 | Rate limit trigger | 1. Fail login 5 times rapidly from same IP.<br>2. 6th attempt. | 6th attempt: 429 `{"error":"rate_limited","retryAfterSec":n}` + `Retry-After` header. |
| 5.4.7 | Rate limit window expiry | After 5.4.6, wait 15 min (or manipulate server clock). | Next attempt: 204 + cookie (if password correct). |
| 5.4.8 | Successful login clears rate limit | 1. Fail 4 times.<br>2. Succeed on 5th.<br>3. Fail again 5 times. | Second series of 5 fails allowed (counter reset on success). |
| 5.4.9 | Rate limit map eviction | 1. Simulate 1001 distinct IPs failing (mock `req.socket.remoteAddress`).<br>2. Check oldest entry evicted. | Map capped at 1000; oldest evicted; no memory leak. |
| 5.4.10 | `PETCAM_PASSWORD` env var override | 1. Set `PETCAM_PASSWORD=env-pass-123`.<br>2. Login with that password.<br>3. Login with file password. | Env var password works; file password rejected (SHA-256 compare with timingSafeEqual). |

### 5.5 Malformed WS Frames

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.5.1 | Invalid JSON | Send `not json` over WS. | Server closes socket with 4400. Client reconnects (backoff). |
| 5.5.2 | JSON array | Send `[]`. | 4400. |
| 5.5.3 | Missing `type` | Send `{}`. | 4400. |
| 5.5.4 | Unknown type | Send `{"type":"nope"}`. | 4400. |
| 5.5.5 | Server-only type from client | Send `{"type":"ping"}` or `{"type":"peer", "present":true}`. | 4400 (reason: `not_allowed` or `bad_message`). |
| 5.5.6 | Role mismatch | As viewer, send `answer` or `talk` from station context (or vice versa). | 4400 (reason: `not_allowed`). |
| 5.5.7 | Oversized frame (>64 KB) | Send `{"type":"pong","pad":"x".repeat(70000)}`. | 4400 (reason: `too_large`). |
| 5.5.8 | Oversized SDP (>32 K chars) | Send offer with `sdp.sdp = "x".repeat(33000)`. | 4400. |
| 5.5.9 | Oversized candidate (>1 K chars) | Send candidate with `candidate = "x".repeat(2000)`. | 4400. |
| 5.5.10 | Malformed candidate fields | Send candidate with `sdpMid=5`, `sdpMLineIndex=-1`, `sdpMLineIndex=1.5`, `sdpMLineIndex="0"`. | 4400. |
| 5.5.11 | Non-boolean talk flags | Send `{"type":"talk","audio":1,"video":false}` or strings. | 4400. |
| 5.5.12 | Extra fields stripped | Send `{"type":"offer","sdp":{...},"evil":1}`. | Server re-serializes only known fields; relayed message has no `evil`. |
| 5.5.13 | Binary frame (Buffer) | Send valid message as binary WS frame. | Parsed correctly (protocol.ts accepts `Uint8Array`). |
| 5.5.14 | Flood of small invalid frames | Send 100 invalid frames rapidly. | Each gets 4400; server does not crash; client backs off. |

### 5.6 `next` Open-Redirect Attempts

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.6.1 | `next=/` (valid) | GET `/login?next=/` → login → submit. | Redirects to `/`. |
| 5.6.2 | `next=/station` (valid) | GET `/login?next=/station` → login → submit. | Redirects to `/station`. |
| 5.6.3 | `next=/evil` | GET `/login?next=/evil` → login → submit. | Redirects to `/` (fallback). |
| 5.6.4 | `next=https://evil.com` | GET `/login?next=https://evil.com` → login → submit. | Redirects to `/`. |
| 5.6.5 | `next=//evil.com` | GET `/login?next=//evil.com` → login → submit. | Redirects to `/`. |
| 5.6.6 | `next=/../etc/passwd` | GET `/login?next=/../etc/passwd` → login → submit. | Redirects to `/`. |
| 5.6.7 | `next` with query string | GET `/login?next=/?foo=bar` → login → submit. | Redirects to `/` (exact match only). |
| 5.6.8 | Case sensitivity | GET `/login?next=/STATION` → login → submit. | Redirects to `/` (exact match). |
| 5.6.9 | Double encoding | GET `/login?next=%2Fstation` → login → submit. | Redirects to `/station` (decoded once). |

### 5.7 Expired / Tampered Cookies

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.7.1 | Expired cookie (`expSec` in past) | 1. Login, get cookie.<br>2. Edit cookie `expSec` to `Math.floor(Date.now()/1000) - 3600`.<br>3. Request `/api/session`. | 401 `{"error":"unauthorized"}`. Client redirects to `/login?next=…`. |
| 5.7.2 | Tampered HMAC | 1. Login, get cookie.<br>2. Flip last char of base64url HMAC.<br>3. Request `/api/session`. | 401 (timingSafeEqual fails). |
| 5.7.3 | Cookie from different session secret | 1. Login on server A.<br>2. Copy cookie to server B (different `sessionSecret`).<br>3. Request `/api/session`. | 401. |
| 5.7.4 | Cookie with future expiry but wrong secret | 1. Forge cookie with valid future `expSec` but random HMAC.<br>2. Request `/api/session`. | 401. |
| 5.7.5 | Cookie missing `HttpOnly`/`Secure`/`SameSite` | Inspect `Set-Cookie` header on login. | All three flags present; `Path=/`; `Max-Age=2592000`. |
| 5.7.6 | Sliding expiry on `/api/session` | 1. Login, note cookie `expSec`.<br>2. Wait 10 s, call `/api/session`.<br>3. Check new cookie `expSec` ≈ now + 30 days. | New cookie issued with extended expiry. |
| 5.7.7 | Password change invalidates sessions | 1. Login, get cookie.<br>2. Run `npm run set-password` (new password).<br>3. Use old cookie on `/api/session`. | 401 (verifier changed → signing key changed). |
| 5.7.8 | `PETCAM_PASSWORD` env change invalidates sessions | 1. Login with file password.<br>2. Set `PETCAM_PASSWORD=new`, restart server.<br>3. Use old cookie. | 401 (verifier now env var SHA-256). |

### 5.8 Security Headers & CSP

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.8.1 | CSP on HTML pages | `curl -I https://host:port/` | `Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` |
| 5.8.2 | CSP on `/api/*` | `curl -I https://host:port/api/session` (with cookie) | Same CSP + `Cache-Control: no-store`. |
| 5.8.3 | Security headers on all responses | Check `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self), microphone=(self), screen-wake-lock=(self)`. | Present on every response. |
| 5.8.4 | No inline scripts/styles in HTML | View page source of `/`, `/station`, `/login`. | No `<script>`, `<style>`, `onclick=`, etc. All in external files. |
| 5.8.5 | Static assets served from memory, not fs | 1. Start server.<br>2. Delete `dist/public/assets/styles.css`.<br>3. Request `/assets/styles.css`. | 200 OK (served from in-memory manifest). |
| 5.8.6 | Path traversal on `/assets/` | Request `/assets/../../etc/passwd`. | 404 (no fs access). |

---

### 5.9 Security Design Review Findings (PLAN.md § "Security design review")

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| 5.9.1 | Local CA public endpoint (`GET /ca.crt`) | 1. Start server.<br>2. `curl -k https://localhost:8443/ca.crt`.<br>3. Verify cert content. | 200 OK; PEM contains only CA public cert (no private key). Response has `Content-Type: application/x-x509-ca-cert`. |
| 5.9.2 | CA stability on IP change | 1. Start server, save `ca.crt` fingerprint.<br>2. Change LAN IP (or add interface).<br>3. Restart server.<br>4. Fetch new `ca.crt`. | New leaf cert has new IP in SAN; **CA cert unchanged** (same fingerprint). No new browser warning after CA is trusted once. |
| 5.9.3 | Config watch: `set-password` closes WS with 4401 | 1. Login both roles, establish live video.<br>2. Run `npm run set-password` (new password).<br>3. Observe both clients. | Both WS closed with code **4401**; clients land on `/login?next=…`; old cookies rejected (401 on `/api/session`). |
| 5.9.4 | Config watch: `revoke-sessions` closes WS with 4401 | 1. Login both roles, establish live video.<br>2. Run `npm run revoke-sessions`.<br>3. Observe both clients. | Same as 5.9.3: 4401, redirect to login, old cookies invalid. |
| 5.9.5 | Rate limit under concurrency (20 parallel) | 1. Start server with `PETCAM_PASSWORD=test-password-123`.<br>2. Fire 20 parallel `curl -X POST /api/login -d '{"password":"wrong"}'` from same IP.<br>3. Count 401 vs 429 responses. | **No more than 5** get 401; remaining get **429** with `Retry-After`. No 500s or crashes. |
| 5.9.6 | Password minimum 12 chars enforced | 1. Try `npm run set-password` with `short`. | Rejected with error (exit code ≠ 0); message mentions minimum 12 characters. |
| 5.9.7 | Station role + `/station` loopback-only | 1. From LAN IP: `curl -k https://<LAN_IP>:8443/station`.<br>2. From localhost: `curl -k https://localhost:8443/station` (or via SSH tunnel). | LAN IP: **403** (or redirect to login with 403 on WS upgrade).<br>Localhost: 200/302 to login (allowed). |
| 5.9.8 | Cookie name is `__Host-petcam_session` | 1. Login, inspect `Set-Cookie` header. | Cookie name exactly `__Host-petcam_session`; has `Secure; Path=/; HttpOnly; SameSite=Strict`; no `Domain` attribute. |
| 5.9.9 | Origin check on all non-GET (including `/api/logout`) | 1. Login, get cookie.<br>2. `curl -X POST /api/logout` **without** `Origin` header.<br>3. `curl -X POST /api/logout` with `Origin: https://evil.com`. | Both: **403** (or 401) with `{"error":"forbidden"}`; no logout performed. Valid `Origin: https://<host>:<port>` → 204 + cookie cleared. |
| 5.9.10 | Login page has CA install link | 1. Open `/login` in browser.<br>2. Check for link/button to `/ca.crt`. | Visible link "Install CA certificate" (or similar) pointing to `/ca.crt`. |

---

## 6. Real-Phone Acceptance Checklist (ARCH §11 + Security Review)

**Run by the end user on their actual phone over the home VPN.** This cannot be automated by the team. The user follows the README / USER_GUIDE.md and checks each item.

| # | Assumption | Checklist Item | Pass / Fail / Notes |
|---|------------|----------------|---------------------|
| 0 | **CA install & cert warning rule** | ☐ On laptop: open `https://<laptop-lan-ip>:8443/ca.crt` → download/install CA on phone (or use mkcert).<br/>☐ **Rule: never proceed past a cert warning** — if Chrome shows "Your connection is not private", STOP. Fix CA trust first. | |
| 1 | Phone on VPN reaches laptop LAN IP over UDP (no STUN) | ☐ On laptop: open `https://<laptop-lan-ip>:8443/ca.crt` → download/install CA on phone (or use mkcert).<br/>☐ **Rule: never proceed past a cert warning** — if Chrome shows "Your connection is not private", STOP. Fix CA trust first.<br/>☐ Phone Chrome opens `https://<laptop-lan-ip>:8443/` (no cert warning expected after CA install).<br/>☐ Login succeeds.<br/>☐ Viewer shows live laptop video+audio within ~3 s.<br/>☐ `chrome://webrtc-internals` shows peer-reflexive candidate for laptop, ICE connection state `connected`. | |
| 2 | Chrome Android permits getUserMedia + WSS after self-signed cert | ☐ Viewer "Talk" button works: phone prompts for camera/mic, grants, laptop shows phone video full-screen with audio.<br/>☐ "Push to talk" works: hold button → laptop audio plays; release → stops.<br/>☐ "Stop talking" releases phone tracks. | |
| 3 | Station plays incoming audio unattended after single "Start" click | ☐ On laptop: open `/station`, login, click "Start station" (user gesture).<br/>☐ Walk away; do not interact with laptop.<br/>☐ From phone: tap "Talk" → laptop plays audio automatically (no further click).<br/>☐ Restart server → laptop still plays audio when phone Talks again (no new gesture needed). | |
| 4 | Chrome doesn't throttle/discard station tab | ☐ Leave station tab open overnight (laptop on AC, sleep disabled).<br/>☐ Next morning: phone opens viewer → video live immediately (no "Station offline").<br/>☐ Wake lock held (check `navigator.wakeLock` in devtools if needed). | |
| 5 | Echo cancellation suppresses loop-back | ☐ Phone on speaker (not headset), volume up.<br/>☐ Tap "Talk" on phone, speak.<br/>☐ Laptop plays phone audio; phone mic should not pick up laptop speaker strongly enough to cause feedback.<br/>☐ If feedback occurs: fallback = default phone to PTT (half-duplex). | |

**Fallbacks documented in README**:
- Firewall rule: `sudo nft add rule inet filter input udp dport 49152-65535 accept` (or equivalent) for Chrome's ephemeral UDP ports.
- mkcert: `mkcert -install` on laptop + phone; `PETCAM_TLS_CERT/KEY` pointing to mkcert cert for laptop's LAN IP.

---

## 7. Test Execution Order

1. **Clean-checkout smoke** (§3) — must pass before anything else.
2. **Automated E2E** (`npm test`) — must pass.
3. **Manual exploratory** (§5) — run in any order; record defects with repro steps.
4. **Real-phone checklist** (§6) — user runs after delivery; results appended to QA_REPORT.md.

---

## 8. Defect Reporting

Each defect recorded in `docs/QA_REPORT.md` with:

- **Ticket ID** (e.g. `T8-RESTART-01`)
- **Severity**: Critical / High / Medium / Low
- **Reproduction steps** (exact, minimal)
- **Expected vs actual behaviour**
- **Environment** (Node version, OS, browser version, network)
- **Owner** (Ben / Fiona / Dana)
- **Status**: Open / Fixed / Verified / Won't Fix

---

## 9. Sign-Off Criteria

PetCam is QA-approved when:

- [ ] Clean-checkout smoke passes (§3).
- [ ] `npm test` passes (typecheck + unit + E2E).
- [ ] All manual exploratory cases in §5 executed; no Critical/High defects open.
- [ ] **Security design review cases (§5.9) executed; all pass.**
- [ ] Real-phone checklist (§6) completed by user with ≤ 2 Medium findings (documented workarounds acceptable).
- [ ] Security review (T9) findings ≥ Medium fixed.
- [ ] `docs/QA_REPORT.md` finalized with verdict per ticket.

---

## 10. Appendix: Useful Commands

```bash
# Clean checkout verification
rm -rf data dist node_modules .cache .env && npm install && npm run build && npm start &

# Run only unit tests
npm run test:unit

# Run only E2E (after test:setup)
npm run test:e2e

# Manual WS test with wscat (install: npm i -g wscat)
wscat -c "wss://localhost:8443/ws?role=viewer" -H "Cookie: __Host-petcam_session=..." --no-check

# Simulate rate limit (5 quick fails)
for i in {1..6}; do curl -k -X POST https://localhost:8443/api/login -H "Content-Type: application/json" -d '{"password":"wrong"}'; done

# Check cert fingerprint
openssl x509 -in data/tls/cert.pem -noout -fingerprint -sha256

# Inspect cookie
curl -k -v -X POST https://localhost:8443/api/login -H "Content-Type: application/json" -d '{"password":"test-password-123"}' -c /tmp/cookies.txt
cat /tmp/cookies.txt

# Security design review helpers
# Fetch CA cert
curl -k https://localhost:8443/ca.crt

# Test loopback-only /station (403 from LAN, 200 from localhost)
curl -k https://<LAN_IP>:8443/station
curl -k https://localhost:8443/station

# Test Origin check on logout
curl -k -X POST https://localhost:8443/api/logout  # no Origin → 403
curl -k -X POST https://localhost:8443/api/logout -H "Origin: https://evil.com"  # bad Origin → 403
curl -k -X POST https://localhost:8443/api/logout -H "Origin: https://localhost:8443"  # valid → 204

# Concurrency rate limit test (20 parallel)
for i in {1..20}; do curl -k -X POST https://localhost:8443/api/login -H "Content-Type: application/json" -d '{"password":"wrong"}' & done; wait

# Config watch: trigger set-password on running server
npm run set-password

# Config watch: trigger revoke-sessions on running server
npm run revoke-sessions
```

---

*End of TEST_PLAN.md*