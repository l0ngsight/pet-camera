# PetCam — Security Review

Reviewer: Sam (AppSec). Scope: **design review** of `docs/ARCHITECTURE.md` v1 and `src/shared/protocol.ts` (2026-10-10). No server or client code exists yet, so there is no dependency audit yet. A code review pass will follow once Ben and Fiona land code.

Threat model used (from ARCHITECTURE §9): one owner. Every other host on the LAN or VPN is untrusted, including guests on Wi-Fi and compromised IoT devices. The asset is the live audio and video from inside the home, in both directions. Physical access to the laptop is out of scope.

## Verdict

**The design is sound overall. There are 0 critical, 0 high, 3 medium and 5 low findings.** None of them needs an architecture change. The medium items must be fixed before release (PLAN DoD #7). Good choices that I checked and agree with: no request path reaches `fs`; WS frames are validated and re-serialised; there are exact Origin checks on the WS upgrade; JSON-only login (which blocks form CSRF); the `next` allowlist; strict CSP with no inline script; scrypt plus `timingSafeEqual`; secrets gitignored with 0600/0700 modes; media P2P over DTLS-SRTP.

| # | Title | Severity | Owner |
|---|---|---|---|
| M1 | Click-through self-signed cert lets a LAN attacker phish the password via MITM | Medium | Ben (+ README) |
| M2 | Changing the password (the only revocation) does not reach the running server or live sockets | Medium | Ben |
| M3 | Login rate limit can be bypassed by parallel requests; scrypt params fail as specified | Medium | Ben |
| L1 | Any authenticated client can take the station role (and receive the owner's camera) | Low | Ben + Fiona |
| L2 | Cookie not port-isolated; use the `__Host-` prefix | Low | Ben |
| L3 | No way to revoke a lost phone's cookie without changing the password; logout is client-side only | Low | Ben |
| L4 | `POST /api/logout` has no CSRF protection, and Host is not validated | Low | Ben |
| L5 | First-run password printed to stdout can persist in logs; weak password policy | Low | Ben |

---

## M1 — Click-through self-signed cert lets a LAN attacker phish the password via MITM
- **Severity**: Medium
- **Location**: ARCHITECTURE §5 (TLS), §9.7 (accepted risk)
- **Impact**: A LAN attacker gets the password, and with it live camera and mic access inside the home.
- **Reasoning**: The design teaches the user to click past a certificate warning. The cert is also **regenerated whenever the laptop's DHCP address changes** (§5), so the warning keeps coming back and the user learns to accept it. A host on the LAN (a guest device or a compromised IoT box) can ARP-spoof the laptop and present its own self-signed cert. Chrome on Android shows the same generic warning. The user clicks through as usual and types the password into the attacker's proxy. The "print the SHA-256 fingerprint" mitigation doesn't work in practice: the banner is on the laptop, and Chrome on Android makes the cert fingerprint very hard to inspect. The VPN does not help, because the last hop is the untrusted LAN.
- **Fix** (small, and it also improves UX):
  1. On first start, generate a **persistent local CA** (`data/tls/ca.pem` and `ca-key.pem`, 0600, valid for about 10 years, `basicConstraints cA:true, pathLen:0`). If `selfsigned`/forge supports it, add **nameConstraints** that allow only `localhost`, `.local` and the private ranges 10/8, 172.16/12 and 192.168/16. With these, a leaked CA key cannot sign certificates for public sites.
  2. Have that CA sign the leaf cert. Keep the SAN-regeneration logic in §5, but **reissue only the leaf**, so IP changes no longer bring the warning back.
  3. Serve the CA cert (public part only) at a public `GET /ca.crt` (`application/x-x509-ca-cert`). Add a README section on installing it on Android (Settings → Security → Encryption & credentials → Install a certificate → CA certificate). Chrome on Android trusts user-installed CAs. Print the CA fingerprint in the banner.
  4. In the README, say clearly: "After installing the CA you should **never** see a certificate warning. If you do, don't proceed and don't type your password."
  The existing `PETCAM_TLS_CERT`/`KEY` (mkcert) path stays as an alternative.

## M2 — Changing the password (the only revocation) does not reach the running server or live sockets
- **Severity**: Medium
- **Location**: §5 (session key derived at startup), §3 `set-password.ts`, §7 (auth only at upgrade)
- **Impact**: After a suspected compromise the owner runs `npm run set-password` and believes the attacker is locked out. But the running server still holds the **old hash and the old signing key in memory**, so the old password and every old cookie keep working until the server restarts. Separately, cookies are checked only at WS upgrade, so an attacker's open viewer socket keeps receiving the camera even after the key changes.
- **Fix**:
  - Have the server watch `data/config.json` (`fs.watchFile`, polling is fine). On change, reload the hash and the session key, then **close every WS with a new code `4401 UNAUTHORIZED`**. Clients then run their usual `/api/session` preflight, get 401, and go to `/login`. Add `UNAUTHORIZED: 4401` to `CloseCode` in `protocol.ts`, and have Fiona treat it like a 401 (go to login, no backoff loop).
  - Fallback if file watching is out of scope: `set-password` must print "Restart the server for this to take effect (existing sessions and connections are revoked on restart)". A restart already closes all sockets with 1001, and the new key rejects their cookies on reconnect.
  - Unit test: after a key change, the old cookie fails `verify` and open hub connections are closed.

## M3 — Login rate limit can be bypassed by parallel requests; scrypt params fail as specified
- **Severity**: Medium
- **Location**: §6 password check and rate limit
- **Impact / reasoning**:
  1. **TOCTOU**: if the limiter checks "failures < 5", then runs the async scrypt (~60 ms), and only *then* records the failure, an attacker who sends 200 concurrent POSTs gets 200 guesses per window instead of 5. The 5/15 min bound only holds if the attempt is counted **before** hashing.
  2. **IP rotation**: a LAN host can bind many addresses in the /24 (around 250 × 5 guesses per 15 min, so about 120k/day). That doesn't matter against the generated 16-char password, but it does matter against a user-chosen 8-char password from `set-password`. If someone later sets `PETCAM_HOST=::`, IPv6 makes per-IP limiting worthless.
  3. **Verified on Node 24.19**: `scrypt` with `N=2^15, r=8` and the default `maxmem` throws `memory limit exceeded`. Each hash costs about 60 ms and 32 MiB. With `scryptSync`, a login flood would also block the event loop and with it signaling and liveness.
- **Fix**:
  - Increment the IP's counter **before** `await scrypt(...)`. On success, clear it. Also allow at most one in-flight attempt per IP, and reject or queue others with 429.
  - Add a **global** failure budget on top of per-IP: for example, more than 20 failures across all IPs in 15 min adds a fixed 2 s delay to every login and logs a warning. Use a delay, not a lockout, so the owner is never locked out.
  - Use async `crypto.scrypt` with `maxmem: 64 * 1024 * 1024`, and store N/r/p in the hash string as already planned.
  - `set-password`: raise the minimum to **12 chars**, or keep 8 and reject a small embedded list of the most common passwords. Apply the same check (a startup warning) to `PETCAM_PASSWORD`.
  - Unit test: 20 concurrent wrong logins from one IP produce at most 5 scrypt calls.

## L1 — Any authenticated client can take the station role
- **Location**: §9.3 ("a client may take either role"), §7 newest-wins + 4409
- **Impact**: Anyone holding the password (for example after M1) can connect with `role=station`. That kicks the real station off with 4409, and by design the station does **not** reconnect, so it stays dead until someone is physically at the laptop. When the owner taps Talk, **the owner's phone camera and mic stream to the impostor**. The same thing can happen by accident, from a stale `/station` tab on another device, and kill the unattended station while the owner is away.
- **Fix**: The station always runs on the laptop itself. Allow `role=station` (and `GET /station`) only when `req.socket.remoteAddress` is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). The README tells the user to open `https://localhost:8443/station`; `localhost` is already in the SAN. Return 403 otherwise. Add an E2E/unit case for it.

## L2 — Cookie not port-isolated; use the `__Host-` prefix
- **Location**: §6 cookie
- **Reasoning**: Cookies ignore ports. Any other HTTPS service on the laptop (a dev server, a NAS UI, etc.) receives `petcam_session`, and an HTTP service on any port of the same host can *set* (toss) a cookie with that name.
- **Fix**: Name it `__Host-petcam_session` (it already has `Secure; Path=/` and no `Domain`, which `__Host-` requires). This is a one-line change and the E2E tests still pass.

## L3 — No way to revoke a lost phone's cookie without changing the password
- **Location**: §5/§6 stateless cookie, `POST /api/logout`
- **Reasoning**: Logout only deletes the cookie in the browser. A copied cookie stays valid, and the sliding refresh makes it valid for as long as it is used. For one user this is acceptable, but recovering from a lost phone should not force a password change.
- **Fix**: Add a `--revoke-sessions` flag to `set-password` (or `npm run revoke-sessions`) that only rotates `sessionSecret`, and route it through the same reload path as M2. Cookie verification must also parse `expSec` strictly (`/^\d{1,10}$/`), compute the HMAC over that exact string, and reject `exp < now` or `exp > now + 30 d + 60 s`.

## L4 — `POST /api/logout` has no CSRF protection, and Host is not validated
- **Reasoning**: `/api/logout` doesn't require JSON or check Origin, so any page the laptop's browser visits could log out the station (a nuisance-level DoS of the unattended station). Separately, Host is never validated. TLS already blocks DNS rebinding with the generated cert, but a user-supplied wildcard or mkcert cert could weaken that.
- **Fix**: For every non-GET request, require `Origin` to equal `https://<Host>`, as the WS upgrade already does. Also reject requests whose `Host` (without the port) is not in the SAN list or the configured names, with a 421. Both are a few lines in `http.ts`.

## L5 — First-run password printed to stdout can persist in logs
- **Location**: §5 first start
- **Reasoning**: If the app ever runs under systemd, pm2 or similar, stdout goes to persistent logs (journald, for example, is readable by the `adm` group). The "once" property only holds for an interactive terminal.
- **Fix**: If `process.stdout.isTTY` is true, prompt for a password interactively (the same code as `set-password`). If not, still generate and print it, but add "change it with `npm run set-password`". Generate it with `crypto.randomInt` over a fixed alphabet (unbiased), never `Math.random`. Never log request bodies, and never log `Cookie` or `Set-Cookie` headers.

---

## Triage (Dana, 2026-10-10)
All findings were approved into scope except the **L4 Host→421** part, which is deferred because it could break mkcert or custom hostnames. Sam agrees: the Origin check on non-GET requests covers CSRF, and TLS already defeats DNS rebinding, because the generated or CA-signed leaf only names localhost, `.local` and LAN IPs. Re-open this if a user-supplied wildcard cert is ever documented.

## Accepted risks (reviewed, agree)
- **Viewer-slot DoS by a password holder** (§9.7): fine. L1 removes the station-slot version of it.
- **30-day sliding cookie**: fine for a single-owner home app, once M2 and L3 give real revocation.
- **Per-IP limiter keyed on `remoteAddress`, ignoring XFF**: correct with no proxy. Note that if the home VPN NATs clients, all remote clients share one IP, so an attacker on the VPN could lock out the owner's new logins for 15 min. The station is unaffected because it is already logged in. Acceptable.
- **ICE exposing LAN IPs to the authenticated peer**: fine.
- **Public sourcemaps under `/assets`**: fine, as long as no secrets are in the client bundles.

## Implementation checklist for the code review pass
- WS auth runs in the `server.on('upgrade')` handler **before** `wss.handleUpgrade` (`noServer: true`), and failures write a raw `HTTP/1.1 401` and destroy the socket.
- The Origin comparison is exact, including the port. Handle a missing Origin by rejecting it.
- `maxPayload: 64*1024` is set on the `WebSocketServer`, and messages are validated via `parse*` with no `JSON.parse` result spread onto objects (prototype-pollution-safe re-serialisation).
- Error responses never include stack traces. Unknown errors become a 500 with `{"error":"internal"}`.
- `data/` is created with `mkdir({mode:0o700})` **and** `chmod`ed if it already exists. Files are written atomically (tmp + rename) with mode 0600.
- `npm audit --omit=dev` is clean, and the lockfile is committed.

---

## Design v1.1 re-check (2026-10-10)
ARCHITECTURE.md v1.1 covers M1–M3 and L1–L5 as triaged. `CloseCode.UNAUTHORIZED = 4401` is in `protocol.ts`. **The design findings are closed.** They will be re-verified in code during the T9 code review.

- **M1 spike re-run by Sam**: `docs/spikes/local-ca.cjs` + `openssl verify -CAfile ca.pem` gives `ok.pem: OK`, while `bad.pem` (www.google.com) and `badip.pem` (8.8.8.8) fail verification. I couldn't test Chromium's own verifier here (there is no certutil to seed an NSS db). Whether Android/Chrome accepts the critical nameConstraints is still open, tracked as ARCH §11 risk #2, and must be checked on the real phone. If Android rejects it, the fallback is to drop nameConstraints rather than go back to click-through.
- **§9.7 bootstrap wording (README, Fiona/Ari):** the fingerprint comparison is the only protection during the one-time install, and the stakes are now *higher* than in v1. An attacker who substitutes their own CA during that download gets a root with **no** name constraints, which means MITM of *all* the phone's HTTPS traffic, not just PetCam. So the README must:
  1. present the comparison as a mandatory step, not a tip: "If the SHA-256 fingerprint does not match exactly, remove the certificate immediately (Trusted credentials → User → PetCam… → Remove) and do not continue";
  2. print the fingerprint in the banner in the **same format Android shows**: uppercase colon-separated hex, i.e. Node's `new X509Certificate(pem).fingerprint256`. Lay it out in groups or over two lines so it is readable;
  3. tell the user to check that the installed name is `PetCam Local CA (<hostname>)`.
- **Implementation notes for Ben** (to check in code review): `/ca.crt` serves a buffer loaded at startup from `data/tls/ca.pem` only. `ca-key.pem` is never read by any request handler and is only used when the leaf is reissued. The leaf key and the CA key are both written 0600.

- **Follow-up closed (Ari):** ARCH §5 banner (CA name + `fingerprint256` in 4 lines), the §9.7 mandatory check with the "remove and stop" wording, and the §11 #2 fallback (drop the constraints, keep the CA) are all in. **The design review is signed off.** What remains is the T9 code review and verifying the README wording.

---

## Preliminary dependency audit (2026-10-10, before T1–T4 are done)
- `npm audit` (all deps, and `--omit=dev`): **0 vulnerabilities**. The lockfile is present and all 138 entries have `integrity` hashes from registry.npmjs.org.
- Runtime tree (22 packages): `ws@8.22.0`, `selfsigned@5.5.0` → `@peculiar/x509@1.14.3`, `@peculiar/asn1-*@2.10.0`, `asn1js@3.0.10`, `pkijs`, `bytestreamjs`, `@noble/hashes`, `pvtsutils`, `pvutils`, `tslib`, `tsyringe@4.10.0`, `reflect-metadata@0.2.2`. These are well-known, maintained packages (the PeculiarVentures/PKI.js family). **No runtime package has install scripts.** The only install script in the whole tree is `esbuild` (dev, its binary fetch, expected).
- **To do for Ben (T2):** `package.json` and `src/server/tls.ts` still use `selfsigned`, and `@peculiar/x509` is only present transitively. That is why the spike resolves it, but it is fragile. Declare `@peculiar/x509`, `@peculiar/asn1-x509` and `@peculiar/asn1-schema` as direct dependencies, remove `selfsigned`, update `external` in `scripts/build.mjs`, and commit the regenerated lockfile. I'll re-run the audit on the final tree in the T9 code review.

---

## T9 code-review verification checklist (each item verified in code, plus a test or a live probe)
| Item | Verify |
|---|---|
| M1 | The CA is created once with critical nameConstraints. Only the leaf is reissued when the SAN or expiry changes. `/ca.crt` serves a buffer from `ca.pem` and returns 404 with a user cert. `ca-key.pem` is never read by a handler. Keys are 0600. The banner shows the name and `fingerprint256`. `openssl verify` passes on the generated chain. |
| M2 | `fs.watchFile(config.json)` reload. A key change closes every WS with 4401. An invalid file keeps the old config. Probe: change the password while a WS is open, and the socket closes with 4401 and the old cookie gets 401. |
| M3 | The attempt is counted before `await scrypt`. One in-flight attempt per IP. Global 2 s delay budget. Async scrypt with maxmem 64 MiB. 12-char minimum. Unit test: 20 concurrent bad logins produce ≤ 5 scrypt calls. Live probe with parallel curl. |
| L1 | `/station` and `role=station` return 403 from a non-loopback address before auth. Covers `::ffff:127.0.0.1`. Probe via the LAN IP. |
| L2 | `__Host-petcam_session` with Secure, Path=/ and no Domain. Strict `expSec` parse, with an upper bound. |
| L3 | `npm run revoke-sessions` rotates only `sessionSecret`, which leads to 4401 via the M2 path. |
| L4 | Every non-GET (including logout) without an exact Origin gets 403 `bad_origin`. |
| L5 | TTY prompt on first run. `randomInt` generation. No cookies or bodies in the logs. |
| Deps | `selfsigned` removed, `@peculiar/*` direct, lockfile committed, `npm audit` clean. |
| General | WS auth before `handleUpgrade`, `maxPayload`, re-serialised frames, no stack traces, 0700/0600 + atomic writes. |

### v1.1 addendum re-check (Ari's CA-recreation note, 2026-10-10)
- **CA recreation** (missing files, key mismatch or expiry → new CA with a loud warning): acceptable. Whoever can delete or replace `data/tls/` already controls the laptop. The phone then shows a cert warning, which is exactly the signal §9.7 teaches the user to stop on.
- **Low, L6 (new): make CA generations distinguishable.** After a recreation the phone holds two CAs both named `PetCam Local CA (<hostname>)`. The user may remove the wrong one, or keep both. The old one stays trusted for private names, and its key may be exactly what was lost or leaked. **Fix:** put the creation date in the CN, `PetCam Local CA (<hostname>, YYYY-MM-DD)`, and print that exact name in the banner. The README "recreated CA" step should then say: remove every PetCam CA except the one whose name *and* fingerprint match the banner.
- Pinned `@peculiar/x509@1.14.3`, random serials, no bare hostname in the SAN (it would violate the CA's own nameConstraints anyway), and a warn-only weak `PETCAM_PASSWORD` (an env var the owner sets explicitly, and used by the tests): all agreed.
- Added to T9: the recreation paths in `tls.ts` (key mismatch is detected by comparing public keys, not by a parse error alone) and that the old CA files are overwritten atomically.

---

## T9 code review + final dependency audit (2026-10-11)

**Verdict: PASS. There are no critical, high or medium findings, so nothing blocks release.** There are 2 new Low findings (L7, L8), both small doc or markup fixes. The code reviewed is `src/server/*`, `src/shared/*`, `scripts/build.mjs`, and `src/client/login.ts`, `lib/signaling.ts` and `pages/*.html` for the auth-related client paths. Unit tests: 231/231 pass. Live probes ran against my own instance (fresh temp data dir, random port, first-run non-TTY path).

### Checklist results (code read + live probe)
| Item | Result | Evidence |
|---|---|---|
| M1 | ✅ | `openssl`: the CA has `basicConstraints critical CA:TRUE pathlen:0` and critical nameConstraints (localhost, local, 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10). The leaf verifies OK with SAN = localhost, `<host>.local`, 127.0.0.1 and the LAN IPs. The banner fingerprint equals `openssl -fingerprint -sha256`, printed in 4×8 groups. `/ca.crt` returns 200 `application/x-x509-ca-cert` with no private key in the body. The key files are 0600 and the dirs 0700. CA recreation uses `checkPrivateKey` (public-key compare), and writes are atomic. |
| L6 | ✅ | CN = `PetCam Local CA (lp5, 2026-10-11 05:36 UTC)`, and the banner prints the exact CN. |
| M2 | ✅ | `revoke-sessions` closed an open viewer WS with **4401**, then the old cookie got 401. `set-password` closed an open station WS with **4401**, then the old password got 401 and the new one 204. A short password is rejected (exit 1). |
| M3 | ✅ | **20 parallel bad logins gave 1×401 and 19×429** (one in flight per IP, counted before scrypt). Sequentially: 401×4, then 429 with `Retry-After: 900`, and the correct password is also 429 while limited. Async scrypt with maxmem 64 MiB. Stored params are bounded (N·r ≤ 2¹⁸). The global delay budget is present. |
| L1 | ✅ | `/station` via the LAN IP returns 403 even with a valid cookie. `role=station` WS via the LAN IP returns 403. Via localhost: page 200, WS OPEN. |
| L2 | ✅ | `Set-Cookie: __Host-petcam_session=…; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`. Tampered exp, far-future exp, a flipped MAC and the un-prefixed name all give 401. |
| L3 | ✅ | `npm run revoke-sessions` rotates only the secret (see M2). |
| L4 | ✅ | Login with no Origin or an evil Origin returns 403. Logout with no Origin returns 403. A form-encoded login returns 415. WS with no Origin, an evil Origin, or the same host on another port returns 403. |
| L5 | ✅ | The non-TTY first run printed a `randomInt` 16-char password once. On a TTY the code prompts (`choosePassword`). The server log (59 lines) contains no password, cookie or body. |
| Deps | ✅ | `selfsigned` is gone. Direct deps: `@peculiar/x509@1.14.3` (pinned), `@peculiar/asn1-x509@2.10.0`, `@peculiar/asn1-schema@2.10.0`, `ws@8.22.0`. `npm audit` (all deps and `--omit=dev`): **0 vulnerabilities**. The only install script in the tree is esbuild (dev). |
| General | ✅ | WS auth runs in `upgrade` before `handleUpgrade` (`noServer`). Without a cookie: 401. Bad role: 400. 2nd viewer: **4409**. A disallowed type (`answer` from viewer): **4400**. A 70 KB frame: 1009 (maxPayload). Frames are re-serialised from known fields only. There is a per-connection message rate limit (200/10 s). Errors become `{"error":"internal"}` with no stack trace. Traversal (`/assets/../..`, `%2e%2e`, `..%2f`, `//etc/passwd`) gives 404. CSP, nosniff and no-referrer are on every response. TLS ≥ 1.2. `requestTimeout` is 30 s. |

### L7 — Login form falls back to a GET with the password in the URL (Low)
- **Location**: `src/client/pages/login.html`, where `<form id="login-form">` has no `method` or `action`.
- **Impact**: `login.js` is a deferred module. If the user presses Enter before it has loaded (a slow VPN link, autofill, `autofocus`), or if the script fails, the browser does a native submit: `GET /login?password=<plaintext>`. The password then ends up in the phone's browser history and URL autocomplete, and possibly in Chrome history sync. The server doesn't log query strings, so the leak is only on the client.
- **Fix** (Fiona, one line): `<form id="login-form" method="post" action="/api/login">`. A native submit is then form-encoded and gets a harmless 415, and nothing goes into the URL. Optionally, render the submit button `disabled` in HTML and enable it in `login.ts`.

### L8 — User guide CA-install steps don't match the real banner (Low, docs)
- **Location**: `docs/USER_GUIDE.md` "One-time step 1" and `README.md` (around line 157).
- **Impact**: the fingerprint comparison is the *only* defence during the CA install (§9.7), but the guide tells the user to look for `Certificate SHA-256: <fingerprint>`. With the local CA, the banner actually prints `CA SHA-256 fingerprint …` over 4 lines, and that label doesn't appear at all. The guide also gives the CA name as `PetCam Local CA (<hostname>)`; the README gives `(<hostname>, YYYY-MM-DD)`, but the real name is `(<hostname>, YYYY-MM-DD HH:MM UTC)`. There is also a stale `TODO(verify)` claiming `/ca.crt` returns 404, which is no longer true. A user who can't match the instructions to the screen is likely to skip the check.
- **Fix** (Tess):
  1. Quote the banner block exactly as printed (the CA name line plus the 4-line fingerprint), and use the real CN format.
  2. Remove the stale TODO.
  3. **Recommend the laptop path as the default**: download `https://localhost:<port>/ca.crt` *on the laptop* (loopback can't be intercepted from the LAN) and send it to the phone via Quick Share or USB. Phone-browser download stays as the second option, with the mandatory fingerprint check. This removes the bootstrap MITM window for most users.

### Not re-raised (accepted by design)
The sliding 30-day cookie; viewer-slot DoS by a password holder; that a localhost login has its own rate-limit bucket (good: an attacker on the LAN can never lock the owner out at the laptop); public sourcemaps; no Host validation (deferred).

### L6/L8 follow-up (2026-10-11)
- **L6 final format**: `PetCam Local CA (<hostname>, YYYY-MM-DD HH:MM UTC)`. It matches the CN I observed live (`PetCam Local CA (lp5, 2026-10-11 05:36 UTC)`), and ARCHITECTURE §5/§9.7, the README and USER_GUIDE now all agree. **Closed.**
- **L8 (USER_GUIDE / README)**: mostly fixed. The banner block is quoted correctly, the name format is right, the mandatory "remove and stop" wording is there, and the stale `/ca.crt` 404 TODO is gone. Two things remain:
  1. The `TODO(verify)` at USER_GUIDE ~line 83 ("dated CA name landed with L6… confirm against the final build") can be removed, because I verified it against the final build above.
  2. Recommendation, not blocking: make "download `https://localhost:8443/ca.crt` **on the laptop** and send it to the phone (Quick Share/USB)" option 1. Today it's a parenthetical, but a loopback download can't be MITMed, so it removes the bootstrap risk entirely. Phone-browser download becomes option 2, with the mandatory check.

### L7/L8 re-check (2026-10-11)
- **L7 closed**: `login.html` now has `<form id="login-form" method="post" action="/api/login">`. A native pre-JS submit is a same-origin form-encoded POST, which gets **415** from the server (probed earlier: a form-encoded login returns 415). Nothing goes into the URL or history.
- **L8 closed**: the stale `TODO(verify)` about the dated CA name has been removed from USER_GUIDE. The "laptop download first" ordering stays a non-blocking recommendation.
- **Final security verdict: PASS. All findings M1–M3 and L1–L8 are closed, except the deferred L4 Host→421 check, which is an accepted risk.**

### L9 — Login rate limit could be bypassed with many addresses (Low–Medium, fixed 2026-10-25)
- **Location**: `src/server/auth.ts` `createRateLimiter`, `src/server/http.ts` `handleLogin`.
- **Impact**: two gaps let an attacker who controls many source addresses (several IPs on the LAN, or any number of IPv6 addresses once `PETCAM_HOST=::`) guess far faster than M3 intended:
  1. The global 2 s delay was a per-request `sleep`, so requests from different addresses all slept in parallel. It added latency, not a throughput cap. Probe: 250 addresses in a /24 got 1250 guesses in one 15-min window.
  2. When the 1000-entry map was full, the oldest entry was evicted even if it was locked out, so cycling through 1000 fresh addresses reset an address's lockout.
  With IPv6 each address of a /64 was its own bucket, so one host had an effectively unlimited number of buckets. The guess rate was then bounded only by scrypt throughput (tens per second). The generated 16-char password is out of reach; a weak user-chosen 12-char one is not.
- **Fix**:
  1. Once the global budget is exceeded, non-loopback logins (delay + hash) run through one global queue, so overall throughput is about one guess per 2 s. At most 5 may be running or queued; extra requests get 429 before they are counted against their address. Loopback skips the queue, so a distributed attack can't stop the owner signing in at the laptop.
  2. Eviction picks the oldest entry that is not locked out and not in flight. If there is none, the new address gets 429.
  3. IPv6 is keyed by its /64, and IPv4-mapped addresses by the IPv4 address.
- **Trade-off (accepted)**: while an attack keeps the global budget exceeded, a *new* login from the phone may get 429 when the queue is full. Phones already signed in keep working (sliding 30-day cookie), and the laptop is never queued. This replaces the old "a delay, never a lockout" wording, which only held because the delay didn't limit anything.
- **Tests**: `auth.test.ts` (eviction keeps lockouts, refuses when every slot is locked or in flight, expired lockouts are evictable), `api.test.ts` (throttled logins from 12 addresses never overlap, at most 5 run, the laptop gets in during the burst; a queue-full 429 doesn't use up the address's attempts; IPv6 per /64; `rateLimitKey` notation cases). All of them fail against the previous code.
