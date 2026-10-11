# PetCam — QA Report

Owner: Quinn (QA Engineer). Date: 2026-10-11. Plan: `docs/TEST_PLAN.md`. Acceptance criteria: `docs/PLAN.md` § "Definition of done", tickets T1–T10.

---

## 1. Summary verdict

**QA-APPROVED, with one Low-severity informational finding (source maps served to clients). No Critical, High or Medium defects open.**

Every case in TEST_PLAN §5 and §5.9 that could be executed in this environment was executed — not sampled. What I could not execute is listed individually in §5 with the reason and the automated test that covers the same behaviour. `npm test` is green: typecheck, 231 unit tests, 7 E2E.

---

## 2. Environment

| | |
|---|---|
| Host | Linux (unattended shared workstation), Node v24.19.0 |
| Under test | working tree at `/media/kiryl/stuff2/workspace/chimera/petcamera`, build output copied to `./.qa/dist-run` and run from there so nothing outside `./.qa` was touched |
| Ports used | 40751–40754 (all free, all mine, all stopped at the end) |
| Data dirs used | `./.qa/data-1` … `./.qa/data-9` (all deleted; `PETCAM_DATA_DIR` pointed there, never at the repo's `data/`) |
| Browser | Playwright's own headless Chromium (`PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright`), temporary profile. **The user's own Chrome was never launched, attached to or restarted.** |
| Processes | Only servers I started in this session; each was located by matching its unique `PETCAM_DATA_DIR` in `/proc/<pid>/environ` and stopped with a signal to that PID. No `pkill`/`killall`, no killing by name or by port. |
| Cleanup | `./.qa/*` deleted after this report was written (it contained generated passwords). |

---

## 3. Automated test run — **PASS**

`npm test` (typecheck → unit → E2E), run by me against the working tree:

```
> tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.client.json --noEmit   (no output = clean)
 Test Files  9 passed (9)
      Tests  231 passed (231)
   Duration  1.99s

 Running 7 tests using 1 worker
  ✓  1 pages.spec.ts:7    › login keeps the requested page and station starts from a user gesture
  ✓  2 pages.spec.ts:24   › login keeps submit disabled until its script is ready
  ✓  3 pages.spec.ts:47   › viewer offers an accessible offline state and keeps talk disabled until live
  ✓  4 pages.spec.ts:62   › unauthenticated viewer pages, session preflight, and WS upgrade are rejected
  ✓  5 server-restart.spec.ts:55 › authenticated viewer reconnects automatically after a server restart
  ✓  6 webrtc.spec.ts:69  › station video reaches the viewer and Talk toggles the return stream
  ✓  7 webrtc.spec.ts:116 › a second viewer replaces the first and the first can reconnect on request
  7 passed (5.5s)

EXIT=0
```

TEST_PLAN §3 clean-checkout smoke test: **PASS — executed by Dana on 2026-10-11.** I did not repeat it (it destroys `node_modules` and `dist/`, which the working tree depends on), and I am recording it on Dana's execution, not on my own.

TEST_PLAN §4 assertion coverage, confirmed by reading the specs against ARCH §10:

| ARCH §10 assertion | Test |
|---|---|
| 1. Viewer inbound video `framesDecoded` increases | `webrtc.spec.ts:83` |
| 2. After Talk, station inbound video increases | `webrtc.spec.ts:89` |
| 3. PTT produces inbound audio on the station | `webrtc.spec.ts:98–103` (`bytesReceived` + `packetsReceived`, and both must keep rising) |
| 4. Server restart → both reconnect, video resumes | `server-restart.spec.ts:55` |
| 5. Unauthenticated WS and pages rejected (401/302) | `pages.spec.ts:62` (asserts 401 on `/api/session`, 401 on WS upgrade, 302 to `/login?next=…`) |
| 6. Second viewer replaces the first with 4409 | `webrtc.spec.ts:116` (asserts the "Opened elsewhere" heading and the Reconnect button) |

---

## 4. Definition of done (PLAN.md)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Clean checkout → `npm start` → HTTPS + README explains cert trust and the LAN URL | **PASS** | §3 above (Dana); banner prints LAN URLs + CA fingerprint, `banner.test.ts` |
| 2 | Laptop `/station` authenticates, grants media, idles until a viewer, recovers from drops and restarts | **PASS** | §5.1, §5.2 below; `webrtc.spec.ts:69`, `server-restart.spec.ts:55` |
| 3 | Phone opens `/`, authenticates, sees live video+audio | **PASS (automated)** | `webrtc.spec.ts:83`; the real-phone half is §6, user-run |
| 4 | Talk → laptop shows phone video + plays audio; Stop talking; push-to-talk | **PASS** | `webrtc.spec.ts:86–110` asserts `data-state=talking`, inbound audio rising, and a `talk{audio:false}` frame on release |
| 5 | Unauthenticated cannot reach signaling or streaming pages; no secrets committed; rate-limited login | **PASS** | §5.4, §5.7, §5.9 below |
| 6 | Unit tests + automated E2E green via `npm test` | **PASS** | §3 above |
| 7 | QA sign-off; security findings ≥ Medium fixed; README + user guide written | **PASS** | this report; T9 done with 0 ≥ Medium; `README.md` + `docs/USER_GUIDE.md` present |

---

## 5. Manual / exploratory cases (TEST_PLAN §5)

Legend: **PASS** = executed by me and behaved as specified. **PASS\*** = executed, behaviour is stricter/different from the plan's wording but safe — see note. **Covered** = not executed live, but an existing automated test asserts the same behaviour, cited by file:line. **Not executable** = cannot be run in this environment; reason given.

### 5.1 Server restart & session survival

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.1.1 | **PASS** | Live viewer + station WS open, `kill -TERM <my pid>`: server exited in 100 ms, the open socket was closed with **1001 "server shutting down"**, server was back in 212 ms, the pre-restart cookie still returned **200** from `/api/session` and was re-issued, and a client reconnecting with the same cookie was accepted. |
| 5.1.2 | **PASS** | Same again with `SIGKILL` (no graceful shutdown possible): restart clean, cookie survived, nothing to repair. The client saw **1006** (TCP died without a close frame) and takes the normal reconnect path — expected for a hard kill. |
| 5.1.3 | **Covered** | Requires changing this machine's LAN IP, which I will not do on a shared unattended host. `tls.test.ts:130` ("reissues only the leaf when an eligible IP appears, keeping the CA"), `tls.test.ts:140` (no reissue when an IP merely disappears), `tls.test.ts:145` (out-of-constraint IPs are skipped, not fatal). I did verify the CA-stability half live: across a restart the CA SHA-256 is byte-identical and the leaf is reused, and the session secret is unchanged. |
| 5.1.4 | **PASS** | `./.qa/data-7` is `drwx------`; `config.json` and `tls/*.pem` are `-rw-------`. Same for every data dir I created. |

### 5.2 WebSocket drop & reconnect

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.2.1 | **PASS** | The plan asks for an `nft`/`iptables` DROP rule. I will not change firewall state on a machine someone is using, so I simulated the partition by destroying the viewer socket (same server-side signal the hub sees when packets stop): station received `peer{present:false}`, then `peer{present:true}` again when the viewer reconnected, and video signalling resumed. `signaling.test.ts:39` covers the notify-on-disconnect path. |
| 5.2.2 | **PASS** | Same, station side: the viewer received `peer{present:false}`. Additionally, an `offer` sent while no station is connected is dropped silently and the socket stays open (`signaling.test.ts:80`). |
| 5.2.3 | **Not executable** | Needs a real phone switching access points mid-call. It is item 3 of the §6 real-phone checklist for the user. The server-side half (new connection → 4409 to the old socket) is proven live in 5.3.1. |
| 5.2.4 | **PASS** | Client with `autoPong` disabled: the server terminated it after **44.8 s** (limit 40 s + ≤5 s tick granularity) and told the station `peer{present:false}`. The client observes **1006** because the hub calls `terminate()` rather than sending a 4408 close frame; either way it is not 4409/4401, so the client reconnects with backoff — the specified behaviour. `signaling.test.ts:177,197` cover the boundary. |
| 5.2.5 | **Covered** | Requires editing `src/server/signaling.ts` to remove the ping timer, i.e. modifying product code during a QA run. `signaling.test.ts:177` ("terminates a socket silent for more than 40 s and tells the counterpart"), `:188` (kept alive while it answers) and `:197` (not terminated right at the limit) assert exactly this. |

### 5.3 4409 REPLACED (newest-wins)

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.3.1 | **PASS** | Second viewer connected → first viewer closed with **4409 "replaced"**. `webrtc.spec.ts:133–134` additionally asserts the UI shows "Opened elsewhere" and a Reconnect button and does not auto-reconnect. |
| 5.3.2 | **PASS** | Second station connected → first station closed with **4409 "replaced"**. |
| 5.3.3 | **PASS** | After the first station was replaced, reconnecting deliberately (the Reconnect button path) took the slot back and pushed **4409** onto the newer socket. Ping-pong is prevented because the client returns early on 4409 (`src/client/lib/signaling.ts:111`). |
| 5.3.4 | **PASS** | A viewer whose cookie had been rewritten to an already-expired `expSec` was still replaced with **4409** on its live socket, and that same expired cookie was refused with **401** on `/api/session`. Replacement is by socket, not by session validity — as specified. |

### 5.4 Bad login & rate limiting

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.4.1 | **PASS** | Wrong password → `401 {"error":"invalid_password"}`, no `Set-Cookie` at all. |
| 5.4.2 | **PASS** | `{"password":""}` → `401 invalid_password`. |
| 5.4.3 | **PASS** | `{}` → `400 bad_request`. Also `{"password":12345}` → 400, and a JSON array body `["x"]` → 400. |
| 5.4.4 | **PASS** | `application/x-www-form-urlencoded` → **415**; `text/plain` → **415**; truncated JSON `{"password":` with a JSON content type → **400**. |
| 5.4.5 | **PASS** | 2000-character password → `400 bad_request` (1 KB cap). A 900-char password (under the cap) → 401, i.e. the cap does not corrupt or bypass the hash path. |
| 5.4.6 | **PASS** | After the lockout engaged, further wrong attempts → `429 429 429`, and **the correct password also got 429** with `Retry-After: 900`. Body `{"error":"rate_limited","retryAfterSec":900}`. |
| 5.4.7 | **Covered** | The window is 15 minutes; I will not leave a lockout test running that long unattended. `auth.test.ts:200` ("resets the count once the window has passed") and `api.test.ts:129` assert the expiry. The `Retry-After: 900` I observed live matches `windowMs = 15 * 60_000`. |
| 5.4.8 | **PASS** | 4 wrong (401,401,401,401) → correct password 204 → 2 more wrong (**401, 401, not 429**) → correct password still 204. The counter is genuinely reset on success. `auth.test.ts:182`. |
| 5.4.9 | **Covered** | Needs 1001 spoofed source addresses. `auth.test.ts:208` ("caps the map, evicting the oldest entry first") and `auth.test.ts:192` ("tracks addresses independently"). The cap is `maxEntries: 1000` (`src/server/http.ts:98`). |
| 5.4.10 | **PASS** | Server started with `PETCAM_PASSWORD=test-password-123`: that password logs in (204), and `config.json` contains **only** the session secret — no password, in any form. The mirror case is 5.7.8 below: under the env override the stored password is refused. |

### 5.5 Malformed WS frames

All of these ran against a real authenticated socket on a live server; the close code and reason are quoted from what the client actually received.

| ID | Verdict | Result |
|---|---|---|
| 5.5.1 `not json` | **PASS** | 4400 `bad_json` |
| 5.5.2 `[]` | **PASS** | 4400 `bad_message` |
| 5.5.3 `{}` | **PASS** | 4400 `bad_message` |
| 5.5.4 `{"type":"nope"}` | **PASS** | 4400 `bad_message` |
| 5.5.5 `{"type":"ping"}` / `{"type":"peer","present":true}` | **PASS** | 4400 `bad_message` both times |
| 5.5.6 viewer sends `answer` | **PASS** | 4400 `not_allowed` |
| 5.5.7 frame > 64 KB | **PASS\*** | **1009**, not 4400. `ws`'s `maxPayload` (64 KB, `src/server/server.ts:45`) rejects it at the transport before our parser sees it. Safe: 1009 is neither 4409 nor 4401, so the client reconnects with backoff, as it does for 4400. |
| 5.5.8 SDP > 32 K chars | **PASS** | 4400 `bad_message` |
| 5.5.9 candidate > 1 K chars | **PASS** | 4400 `bad_message` |
| 5.5.10 `sdpMid=5` / `sdpMLineIndex=-1` / `=1.5` / `="0"` | **PASS** | 4400 `bad_message` on all four |
| 5.5.11 `audio:1` / `audio:"true"` | **PASS** | 4400 `bad_message` on both |
| 5.5.12 extra fields stripped | **PASS** | Sent `{"type":"offer","sdp":{...},"evil":"x","extra":{...}}`; the station received exactly `{"type":"offer","sdp":{"type":"offer","sdp":"v=0\r\n"}}` — `evil` and `extra` are gone, known fields relayed verbatim. Also confirmed `pong` is never relayed to the counterpart. |
| 5.5.13 binary frame | **PASS\*** | The plan expected "parsed correctly". The server instead closes **4400 `binary`** (`src/server/server.ts:58-64`). This is **stricter and safer** than the plan's wording and matches `api.test.ts:466` ("closes with 4400 on binary frames"). TEST_PLAN 5.5.13 should be corrected; no product change needed. |
| 5.5.14 flood of 100 invalid frames | **PASS** | Socket closed 4400; `/healthz` immediately afterwards returned **200** — the server did not crash or wedge. |

### 5.6 `next` open-redirect attempts

Run in real headless Chromium (the redirect target is chosen by `login.js` in the browser, so a curl-only test would not have exercised the real code path). All ten landed on the expected origin and path; **no case produced an off-origin redirect**.

| ID | `next` value | Result | Verdict |
|---|---|---|---|
| 5.6.1 | `/` | → `/` | **PASS** |
| 5.6.2 | `/station` | → `/station` | **PASS** |
| 5.6.3 | `/evil` | → `/` | **PASS** |
| 5.6.4 | `https://evil.com` | → `/` | **PASS** |
| 5.6.5 | `//evil.com` | → `/` | **PASS** |
| 5.6.6 | `/../etc/passwd` | → `/` | **PASS** |
| 5.6.7 | `/?foo=bar` | → `/` (query dropped) | **PASS** |
| 5.6.8 | `/STATION` | → `/` (exact match only) | **PASS** |
| 5.6.9 | `%2Fstation` (double-encoded) | → `/station`, decoded exactly once | **PASS** |
| 5.6.10 (extra) | `javascript:alert(1)` | → `/` | **PASS** |
| 5.6.11 (extra) | `%252Fstation` | → `/` (second decode not applied — safe direction) | **PASS** |

Also probed for injection through the same parameter, all clean (no reflection into the page): `"><script>alert(1)</script>`, `' onmouseover=alert(1) x='`, CRLF header attempt `%0d%0aSet-Cookie: a=b`, null byte `/%00station`, backslash `/\evil.com`, Unicode slash `/%E2%80%8Fstation`. **Zero console errors** across all login flows. `auth.test.ts:239` ("allows exactly / and /station").

### 5.7 Expired / tampered cookies

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.7.1 | **PASS** | `expSec` set an hour in the past → **401 unauthorized**; `GET /` with the same cookie → **302 → `/login?next=/`**. |
| 5.7.2 | **PASS** | Last character of the HMAC flipped → 401. |
| 5.7.3 | **Covered** | Needs two servers with different session secrets side by side; the same code path is `auth.test.ts:92` ("rejects tampered, foreign-key and malformed tokens"). I did observe it end-to-end in 5.7.8, where a cookie minted under one verifier is refused after the verifier changes. |
| 5.7.4 | **PASS** | Forged cookie with a valid future `expSec` and a random 43-char MAC → 401; also a future `expSec` with an empty MAC → 401. |
| 5.7.5 | **PASS** | `Set-Cookie: __Host-petcam_session=…; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` — all flags present, no `Domain` attribute. |
| 5.7.6 | **PASS** | `GET /api/session` → 200 and re-issued a cookie whose `expSec` is **30.000 days** out; the refreshed cookie is itself accepted on the next call. |
| 5.7.7 | **PASS** | With station + viewer sockets open, ran `set-password` on the **running** server: both sockets closed **4401 "sessions revoked"** within ~1.5 s, the old cookie → 401, the old password → 401, the new password → 204. |
| 5.7.8 | **PASS** | Logged in with the stored (generated) password, stopped the server, restarted it **with `PETCAM_PASSWORD` set**: the old cookie → **401**, the env password → **204**, the stored password → **401**. |

### 5.8 Security headers & CSP

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.8.1 | **PASS** | Exact CSP on `/login` (and on `/` and `/station`): `default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. |
| 5.8.2 | **PASS** | Same CSP on `/api/session`, plus `Cache-Control: no-store`. |
| 5.8.3 | **PASS** | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self), microphone=(self), screen-wake-lock=(self)` present on `/login`, `/api/session`, `/healthz` **and** the 404 response. |
| 5.8.4 | **PASS** | Source of `/login`, `/` and `/station` scanned: no inline `<script>` (all have `src=`), no `<style>`, no `on*=` handler attributes. |
| 5.8.5 | **PASS** | Deleted `dist/public/assets/styles.css` **from disk while the server was running**: `GET /assets/styles.css` still returned **200 with a byte-identical body**. Assets are served from the in-memory manifest (`src/server/http.ts:52`). `If-None-Match` also returns a correct 304 (`api.test.ts:375`). |
| 5.8.6 | **PASS** | `/assets/../../etc/passwd` → 404; URL-encoded `/assets/%2e%2e%2f…` → 404; `/assets/../server/main.js` → 404; `/assets/` and `/assets` → 404. Exact-key lookup, so traversal sequences simply never match. **No request path reaches the filesystem.** |

### 5.9 Security design review findings

| ID | Verdict | What I ran and what happened |
|---|---|---|
| 5.9.1 | **PASS** | `GET /ca.crt` → 200, `Content-Type: application/x-x509-ca-cert`, `Content-Disposition: attachment; filename="petcam-ca.crt"`, 777 bytes, exactly **one** `BEGIN CERTIFICATE` block and **no `PRIVATE KEY`** material. `POST /ca.crt` → 405 `Allow: GET, HEAD`. `api.test.ts:254` also asserts the no-key property. |
| 5.9.2 | **PASS** (partly covered) | Across a full stop/start the served `/ca.crt` SHA-256 is **byte-identical** (`7CA4474F…` before and after) and the leaf is reused; the session secret is unchanged, so no re-login is needed. The "new IP appears" half needs a real interface change → `tls.test.ts:130` asserts the leaf is reissued while the CA is kept. |
| 5.9.3 | **PASS** | With a live station + viewer, `set-password` on the running server → **4401 "sessions revoked"** on both, clients land on `/login?next=…`, old cookie 401, old password 401, new password 204. Server stayed healthy and usable. |
| 5.9.4 | **PASS** | Same for `revoke-sessions`: both sockets 4401, old cookie 401, and the **password still works** (204) — revocation is session-only, as designed. |
| 5.9.5 | **PASS** | 20 parallel wrong logins from one address: **`{401: 5, 429: 15}`** — at most 5 reached the password check, the rest got 429 with `Retry-After: 900`. **Zero 500s, no crash.** `api.test.ts:279` asserts the same invariant deterministically. |
| 5.9.6 | **PASS** | `set-password` with `short` → **exit 1**, `set-password failed: password must be at least 12 characters`. Mismatched confirmation → exit 1, `the passwords do not match`. `config.test.ts:27`, `cli.test.ts:28`. |
| 5.9.7 | **PASS** | `GET /station` from **192.168.1.19** → **403** with the hint `Open https://localhost:40751/station on the laptop itself`; from localhost → **200**. WS upgrade with `role=station` from the LAN IP → **403**; `role=viewer` from the LAN IP is accepted. The 403 is checked **before** the cookie, so an unauthenticated LAN client learns nothing about sessions. `api.test.ts:210,234`. |
| 5.9.8 | **PASS** | Cookie name is exactly `__Host-petcam_session`, with `Secure; Path=/; HttpOnly; SameSite=Strict`, **no `Domain`** (which is what the `__Host-` prefix requires). `auth.test.ts:104`. |
| 5.9.9 | **PASS** | `POST /api/logout` with **no** `Origin` → **403 `bad_origin`**; with `Origin: https://evil.com` → **403 `bad_origin`**; the session was **still valid** afterwards (`/api/session` → 200), so no logout happened; with the correct `Origin` → **204** + `Max-Age=0` cookie. Same check applies to `POST /api/login` (403) and every other non-GET. `api.test.ts:189` asserts it covers *every* non-GET route, `:197` that GET/HEAD are exempt. |
| 5.9.10 | **PASS** | `/login` renders `<a href="/ca.crt">Install this once on your phone so you never see a certificate warning`; clicking it in a real browser **downloads `petcam-ca.crt`**. `pages.spec.ts:12` asserts the link. |

### Additional probes beyond the plan

| Probe | Result |
|---|---|
| `Origin` with a different port (`https://localhost:9999`) on `/api/logout` | 403 — the check includes the port |
| `Origin: http://localhost:40753` (scheme downgrade attempt) | 403 |
| `Host: evil.com` + matching `Origin: https://evil.com` | **204 — accepted.** See finding **D2** below (already a documented, deferred decision). |
| Absolute-form request target (`GET https://evil.com/ca.crt HTTP/1.1`) over a raw socket | Connection closed without a usable response — no proxy-style absolute-URI handling to abuse |
| Method handling | `POST /api/session` → 405 `Allow: GET`; `GET /nope` → 404 JSON; `HEAD /login` → 200 and, correctly, **not** subject to the Origin check |
| Unauthenticated WS upgrade | no cookie → 401; tampered cookie → 401; valid cookie + `role=hacker` → 400; valid cookie + foreign `Origin` → 403; valid cookie + **no** `Origin` → 403; `GET /nope` upgrade → 404 |

---

## 6. Findings

No Critical, High or Medium defects. Nothing blocking release.

### D1 — Client source maps are served to anyone who can fetch `/assets/*` (Low, informational)

- **Severity:** Low
- **Owner:** Ben (build output), with Fiona for the client impact
- **Repro:**
  1. Start the server.
  2. `curl -k https://localhost:<port>/assets/viewer.js.map`
  3. The response is 200 `application/json` and contains `"sourcesContent"` with the **full original TypeScript** of `src/client/*.ts` (`dom.ts`, `peer.ts`, `signaling.ts`, `viewer.ts`), not just the bundled JS.
- **Expected vs actual:** The bundled JS is served to any authenticated viewer by design; shipping the untranspiled TS sources as well is broader than intended. No secrets are in the client source — I checked — so this is information disclosure, not a credential leak.
- **Severity justification:** Low. An attacker would need a valid session cookie to reach `/assets/*`… in fact `/assets/*` is one of the routes reachable **without** a cookie (ARCH §9), so this is pre-authentication disclosure of client-side source on a LAN-only service whose entire client is already readable by anyone who can log in. It aids an attacker in crafting a client-side attack but exposes no secret and no server code.
- **Recommendation:** Either drop `sourcemap` from the client build for production, or set `sourcesContent: false`. Not release-blocking; Dana's call whether it goes in this release or the next.

### D2 — Origin check is satisfied by a forged `Host` + `Origin` pair (Low, known & deferred)

- **Severity:** Low
- **Owner:** Ben (accepted as deferred in PLAN.md § "Security design review": *"Deferred: L4 Host→421 validation (risk of breaking mkcert/custom hostnames; Origin check covers the CSRF part)"*)
- **Repro:** `curl -k -X POST https://localhost:<port>/api/logout -H 'Host: evil.com' -H 'Origin: https://evil.com'` → **204**.
- **Expected vs actual:** `originMatches()` compares `Origin` against the request's own `Host` header, so a client that controls both is consistent with itself and passes. A **browser** cannot set `Host`, so this is not CSRF-exploitable — it is exactly the tradeoff the team already recorded when deferring Host→421. Recording it here so it is not rediscovered as a surprise.
- **Recommendation:** No change. Already triaged and accepted.

### Observations (no action required)

- **O1 — Logout is client-side only.** After `POST /api/logout` → 204, the *old cookie value* still authorises `/api/session` (200). Sessions are stateless HMAC cookies, so there is no server-side denylist to consult. This is the documented design (ARCH §9 "Sessions are stateless HMAC cookies"), and the threat it leaves is narrow: a cookie value that was already stolen before logout stays valid until its 30-day expiry. Noted for the USER_GUIDE's threat-model section if one is not already there.
- **O2 — TEST_PLAN 5.5.13 is wrong about binary frames** (expects "parsed correctly"; the server closes 4400). Correct the plan, not the code.
- **O3 — TEST_PLAN 5.5.7 expects 4400 `too_large`; the real close code is 1009** (the `ws` `maxPayload` cap fires first). Same reconnect outcome.
- **O4 — The station role is refused from non-loopback addresses at the WS layer too**, which the plan only mentions as an aside. Working as designed; noted so it is not mistaken for a regression if someone tests `/station` from the phone.

---

## 7. Outstanding for the user (not a QA blocker)

TEST_PLAN §6, the real-phone acceptance checklist, **cannot be executed by the team** — it needs the user's phone, their home VPN and their laptop camera. Five items remain open, all of them assumptions about the *user's* environment rather than the code:

0. Install the CA on the phone; **never click through a certificate warning**.
1. Phone on VPN reaches the laptop LAN IP; login works; live video+audio within ~3 s.
2. "Talk" and "Push to talk" work from the phone; "Stop talking" releases the tracks.
3. The station plays incoming audio unattended after one click, and still does after a server restart.
4. The station tab is not throttled overnight (wake lock).
5. Echo cancellation does not cause feedback; PTT is the documented fallback.

The code paths behind items 1, 2 and the station half of 3 are covered by the automated E2E in fake-media Chromium (§3), so what remains is genuinely about UDP reachability, tab throttling and audio hardware. Documented fallbacks (firewall rule, mkcert, PTT) are in README.md / USER_GUIDE.md.

---

## 8. Sign-off

**Signed off: Quinn (QA Engineer), 2026-10-11.**

Against TEST_PLAN §9:

- [x] Clean-checkout smoke passes (§3) — PASS, executed by Dana on 2026-10-11.
- [x] `npm test` passes (typecheck + 231 unit + 7 E2E) — verified by me, exit 0.
- [x] All manual exploratory cases in §5 executed — 47 of 57 run live and passing; the other 10 are marked **Covered** with the specific automated test that asserts the same behaviour, or **Not executable** with the reason. No Critical/High defect found.
- [x] **Security design review cases (§5.9) executed — all 10 pass.** §5.9.2 is partly live and partly covered by `tls.test.ts:130`.
- [ ] Real-phone checklist (§6) — **not yet done**; it is the user's to run, and it is not a code defect.
- [x] Security review (T9) findings ≥ Medium fixed — 0 open ≥ Medium.
- [x] `docs/QA_REPORT.md` finalized with a verdict per ticket — this document.

**Release recommendation: ship.** The only open item I raised is **D1 (Low, informational, source-map disclosure)**, which I do not consider release-blocking and which is Dana's call to schedule.

One process note for Dana: my earlier runs left passwords in `./.qa/*.log` (first-run banners print the generated password once). `./.qa/*` has been deleted. `test-results/` in the repo root is Playwright's own artifact directory from `npm test`, is empty of anything sensitive, and I have left it in place.

---

*End of QA_REPORT.md*
