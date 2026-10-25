# PetCam

Watch your pets from your phone and talk to them, over your home LAN or VPN.

PetCam is a self-hosted web app with two pages that talk to each other directly
(peer-to-peer WebRTC, no cloud, no accounts, no third-party relays):

- **Station** — a page you keep open in Chrome **on the laptop** that has the camera.
  It captures the laptop camera + mic and can play your phone full-screen with sound.
- **Viewer** — the page you open in Chrome **on your phone**. You watch and listen
  to the laptop, and you can send your own camera/mic ("Talk") so the pets can see
  and hear you.

Media never touches the server: the laptop and the phone exchange it directly over
the LAN/VPN. The Node server only serves the pages and relays WebRTC signaling.

> **Docs map** — this README covers install, run, configuration and the test
> commands. The end-user, phone-side setup (certificate trust, firewall, laptop
> power settings, day-to-day use and troubleshooting) lives in
> [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md). The design is in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the security review in
> [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md); the test plan in
> [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md).

---

## Requirements

- **Node 24 or newer** (`node --version`). One dependency tree, no build tools to
  install by hand.
- A laptop that stays **on and awake** while you're away, on the same network as the
  phone (the home VPN puts the phone on the LAN). See
  [Laptop power and sleep](docs/USER_GUIDE.md#laptop-power-lid-and-sleep).
- **Chrome on Android** for the phone (desktop Chrome for the station). iOS is
  best-effort only.

> Phone browsers only allow camera/mic access in a **secure context**, so PetCam
> serves HTTPS with its own certificate. Trusting that certificate on the phone is a
> one-time step — see
> [Trust the certificate on your phone](docs/USER_GUIDE.md#one-time-step-1--trust-the-certificate).

---

## Quick start

```bash
cd petcam              # the checkout
npm install
npm start
```

`npm start` builds the app and starts the HTTPS server (default port **8443**) on all
interfaces. On the **first** start it prints a banner containing everything you need.
Yours will differ in the IP, hostname, fingerprint and password — the layout is:

```
  PetCam is running.

  On the laptop (camera):   https://localhost:8443/station
  On the phone (viewer):
    https://192.168.1.42:8443/

  One-time setup on the phone: install the PetCam CA so Chrome trusts this server.
    https://192.168.1.42:8443/ca.crt
  CA name: PetCam Local CA (laptop-hostname, 2026-10-11 05:37 UTC)
  CA SHA-256 fingerprint (must match exactly what your phone shows after installing;
  if it differs, remove the certificate and do not continue):
    8E:87:15:55:87:75:6B:45
    B3:BB:F2:DB:11:9B:2E:02
    57:40:E2:BA:62:9A:7D:56
    CF:09:8D:7B:D3:41:DE:CD
  After installing it you should never see a certificate warning. If you do, do not proceed.

  ============================================================
   First run: your password is   Xy7Qm2Zk9PdLw4Rt
   It is shown only once. Change it with: npm run set-password
  ============================================================
```

Then:

1. **On the laptop**, open the *"On the laptop (camera)"* URL
   (`https://localhost:8443/station`), sign in, and click **Start station**.
   The camera/mic prompt appears once; grant it and leave the tab open.
   (The station is only reachable from the laptop itself — opening it from the phone
   is refused by design.)
2. **Trust the certificate on the phone** — a one-time step. Download the CA on the
   **laptop** from `https://localhost:8443/ca.crt`, check its name and SHA-256
   fingerprint against the banner (if they differ, stop), then send the file to the
   phone (Quick Share, USB, …) and install it as a *CA certificate*. The exact steps,
   plus the fallback (download over the LAN on the phone), are in
   [Trust the certificate on your phone](docs/USER_GUIDE.md#one-time-step-1--trust-the-certificate).
   Then open one of the *"On the phone (viewer)"* URLs printed in the banner, sign in,
   and you should see live video within a second or two.

### Finding the LAN URL

The banner prints the exact `https://<laptop-lan-ip>:8443/` URL(s) to use on the phone.
If you missed it, re-run `npm start` (the URL list and CA fingerprint are printed
every time; only the password is shown once). You can also open
`https://<laptop-lan-ip>:8443/` from any device on the LAN, and the station is always
`https://localhost:8443/station` on the laptop itself.

> The laptop's IP can change (DHCP). PetCam reissues its certificate to cover the
> current addresses automatically, and the banner always shows the current URLs.

### The first-run password

On the first start in a terminal, PetCam **asks you to choose a password** (input is
hidden; at least 12 characters, no common passwords). When it isn't attached to a
terminal (a service, a script), it instead generates a random 16-character password and
**prints it once** — so don't run it under a service that keeps logs until you've
changed it. Only a scrypt hash is stored, in `data/config.json` — the plaintext is
never written to disk. If you lose it, set a new one (below).

### Changing the password / revoking sessions

```bash
npm run set-password        # prompts twice; needs at least 12 characters
npm run revoke-sessions     # rotates the session secret only (e.g. a lost phone)
```

Both rotate the key that signs session cookies, so **every device is logged out** and
the station tab on the laptop must sign in again. By design this takes effect **live**:
the running server watches `data/config.json`, reloads the key, and closes every open
WebSocket with code `4401`, which sends each page straight back to the sign-in screen —
no restart needed. `set-password` sets a new password hash; `revoke-sessions` rotates
only the session secret (use it to kick off a lost phone without changing the password).

If the configuration file can't be read or is invalid, the server keeps the previous
configuration and logs an error instead of logging everyone out. If `PETCAM_PASSWORD`
is set it overrides the stored password, so `set-password` prints a warning;
`revoke-sessions` still works because it rotates the session secret.

For scripts, `set-password` also accepts the password and its confirmation as two
lines on piped stdin.

---

## Configuration

All optional; set as environment variables or in a `.env` file (gitignored). See
[`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `PETCAM_PORT` | `8443` | HTTPS port (`0` = pick a random free port) |
| `PETCAM_HOST` | `0.0.0.0` | Bind address |
| `PETCAM_DATA_DIR` | `./data` | `config.json` (0600) and `tls/` live here; gitignored |
| `PETCAM_PASSWORD` | – | Plaintext password; overrides the stored hash (used by tests). Anything shorter than 12 characters, or a common password, logs a startup warning |
| `PETCAM_TLS_CERT` | – | Path to your own certificate (e.g. from mkcert) |
| `PETCAM_TLS_KEY` | – | Path to the matching private key; must be set together with the cert |

Generated state lives in `data/` (gitignored). By design, TLS works like this
(SECURITY_REVIEW M1, ARCHITECTURE §5):

- On first start PetCam creates a **persistent local CA** (`data/tls/ca.pem`,
  `ca-key.pem`, mode 0600) and signs a short-lived **leaf** certificate from it. Only
  the leaf is reissued — when it is missing, expires within 30 days, or does not cover
  the machine's current LAN IPs/hostname — so the CA, and your phone's trust in it,
  stays stable across IP changes. The CA is name-constrained to `localhost`, `.local`
  and the private IP ranges.
- The CA certificate (public part only) is served at **`GET /ca.crt`** for the one-time
  install on the phone (see the
  [User guide](docs/USER_GUIDE.md#one-time-step-1--trust-the-certificate)), and the
  banner prints its name and SHA-256 fingerprint in the same format Android shows.
- If the CA is ever recreated, its name carries the creation date and time:
  `PetCam Local CA (<hostname>, YYYY-MM-DD HH:MM UTC)`. On the phone, open **Settings →
  Trusted credentials → User** and remove every PetCam CA whose name and SHA-256
  fingerprint do **not** exactly match the laptop banner.
- Using your own cert via `PETCAM_TLS_CERT`/`PETCAM_TLS_KEY` (the mkcert path) replaces
  both parts and makes `/ca.crt` return 404.

Only IPv4 addresses inside the CA's permitted ranges (`127/8`, `10/8`, `172.16/12`,
`192.168/16`, `100.64/10`) go into the leaf; other addresses are logged and skipped.
`ca-key.pem` is read only at startup (to sign a new leaf) and is never served.

---

## Endpoints (for scripts and monitoring)

Every response carries a strict CSP, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and a camera/mic/wake-lock `Permissions-Policy`. Every
non-GET request must send an exact `Origin` (`https://<host>`) or it gets `403`.

| Method and path | Auth | Result |
|---|---|---|
| `GET /healthz` | none | `200` `ok` (plain text) — a good readiness probe |
| `GET /ca.crt` | none | `200` the CA certificate PEM (`attachment; filename="petcam-ca.crt"`); `404` when you use your own cert |
| `GET /login` | none | `200` login page |
| `POST /api/login` body `{"password":"…"}` | + `Origin` | `204` + `Set-Cookie`; `401` `invalid_password`; `415` unless `Content-Type: application/json`; `400` bad body; `429` `rate_limited` |
| `GET /api/session` | cookie | `200` `{"ok":true}` + a refreshed cookie; `401` `unauthorized` |
| `POST /api/logout` | + `Origin` | `204`, cookie cleared |
| `GET /` | cookie | `200` viewer HTML; `302` to `/login?next=/` |
| `GET /station` | **loopback** + cookie | `200` station HTML; `403` from any other address; `302` to `/login?next=/station` |
| `WSS /ws?role=viewer\|station` | cookie + `Origin` (loopback for `station`) | `101`; else `401`/`403`/`400`/`404` |

Examples (run on the laptop; `-k` accepts PetCam's own certificate):

```bash
curl -k https://localhost:8443/healthz

# sign in and print the cookie, then reuse it:
curl -k -i -X POST -H 'Content-Type: application/json' \
  -H 'Origin: https://localhost:8443' \
  --data '{"password":"<your password>"}' https://localhost:8443/api/login

curl -k -i -b '__Host-petcam_session=<token from Set-Cookie>' \
  https://localhost:8443/api/session
```

---

## Tests

```bash
npm run test:setup   # one-time: downloads a headless Chromium into ./.cache (gitignored)
npm test             # typecheck + unit tests (vitest) + end-to-end (Playwright)
```

Individual steps:

```bash
npm run typecheck    # tsc for the server and client configs
npm run test:unit    # vitest: protocol, auth, signaling hub, config, TLS, banner, HTTP/WSS API
npm run test:e2e     # Playwright: viewer receives laptop video, Talk/PTT, 4409 replacement,
                     # unauthenticated rejection (headless Chromium, fake media devices)
```

The E2E suite launches its **own** headless Chromium (bundled by Playwright, with
`--use-fake-device-for-media-stream`) and never touches a browser you have open. It
runs the server at `https://127.0.0.1:18443` — override the port with `PETCAM_E2E_PORT`
if that one is busy — with a temporary `PETCAM_DATA_DIR` and
`PETCAM_PASSWORD=test-password-123`.

---

## Repo layout

```
docs/            ARCHITECTURE.md · SECURITY_REVIEW.md · TEST_PLAN.md · PLAN.md · USER_GUIDE.md
src/server/      main.ts (entry) · server.ts (HTTPS + WS wiring) · http.ts (routes/headers/static)
                 signaling.ts (socket-free hub) · auth.ts · config.ts · tls.ts · log.ts
                 banner.ts · cli.ts · prompt.ts · set-password.ts
src/client/      login/viewer/station pages + lib/ (signaling, peer) + styles.css
src/shared/      protocol.ts (message types + validators) · next.ts
scripts/         build.mjs (esbuild)
test/unit/       vitest  ·  test/e2e/  Playwright
data/            runtime state, gitignored  ·  dist/  build output, gitignored
```

Build output: `dist/server/*.js`, `dist/public/pages/{login,viewer,station}.html`,
`dist/public/assets/*` (JS bundles + `styles.css`).

---

## Troubleshooting

Short pointers; the full list is in
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md#troubleshooting).

| Symptom | First thing to check |
|---|---|
| "Your connection is not private" on the phone | The certificate isn't trusted yet — install the CA. **Never** click through and type your password. See the user guide. |
| Viewer says "Your station is offline" | The station tab on the laptop is closed or not started (and the laptop must be awake). Open `https://localhost:8443/station` and click **Start station**. |
| No video, or video but no sound | Firewall/UDP between the phone and laptop, and Chrome's autoplay for sound. See the user guide. |
| `EADDRINUSE` on start | Port 8443 is taken — set `PETCAM_PORT` to another port. Do not kill the process on that port. |
| "Opened elsewhere" | Another tab/device took the same role (newest wins). Click **Reconnect** to take it back. |

---

## Security notes (short)

- One shared password, stored as a scrypt hash; logins are rate-limited.
- Sessions are signed cookies named `__Host-petcam_session` — the `__Host-` prefix
  forces `Secure`, `Path=/` and no `Domain` — plus `HttpOnly` and `SameSite=Strict`,
  30-day sliding. The expiry is parsed strictly and bounded.
- Every non-GET request (login, logout) must carry an `Origin` equal to the page's own
  origin, and so must the WebSocket handshake.
- Login attempts are counted before the password is hashed, one at a time per address
  (IPv6 per `/64`), at most 5 per 15 minutes. After more than 20 failures from anywhere,
  every login is delayed by 2 s and logins from other devices run **one at a time**, so
  the delay caps the total guess rate; while 5 are already waiting, further ones get
  `429` straight away. Logins on the laptop itself are never queued, and devices that are
  already signed in stay signed in.
- The station role and the `/station` page are **loopback-only**: they answer 403 to
  any other address, before the sign-in check. (If you reach the laptop through an SSH
  tunnel or a local reverse proxy, the server sees loopback — don't do that.)
- Media is end-to-end encrypted (DTLS-SRTP) between the two browsers and is never
  recorded.
- Anything on the LAN/VPN other than your phone and laptop is treated as untrusted.
