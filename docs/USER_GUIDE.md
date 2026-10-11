# PetCam — User Guide

For the person using PetCam: installing it once on your phone, leaving the laptop set
up so it keeps working while you're away, and using it day to day.

- **Install / run / configure the server** → [`../README.md`](../README.md).
- **Design and internals** → [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Verified against the build.** Written from `docs/ARCHITECTURE.md` v1.1 and
> `docs/SECURITY_REVIEW.md`. The server behaviour, banner, endpoints, commands and UI
> labels below were re-checked on 2026-10-11 against a running build (`npm run build` /
> `npm start`, the CLI, and `npm run typecheck && npm run test:unit && npm run test:e2e`).
> The checks that depend on your own phone and OS — Chromium accepting the CA,
> firewall/UDP on your network, the OS power settings, and the on-device UI — are written
> as boxes in [First-time on your phone](#first-time-on-your-phone) and the
> [Real-phone acceptance checklist](#real-phone-acceptance-checklist), so nothing below is
> left as an open question.

---

## What you need

- The **laptop** (the camera) powered on, awake and on your home network.
- Your **phone** with Chrome, on the same home network — either directly on the Wi-Fi
  or connected to the home VPN.
- The PetCam password (printed once on the laptop's first start).

There are three one-time setup steps (certificate, firewall, laptop power), then using
PetCam is just two tabs.

---

## One-time step 1 — Trust the certificate

Phone browsers only give a web page access to the camera and microphone in a **secure
context**. PetCam serves HTTPS with its **own certificate authority (CA)**, which the
phone has never seen before, so you must tell the phone to trust it **once**. After
that you should never see a certificate warning again.

### Install the PetCam CA on Android

The CA is a single file, `petcam-ca.crt`. Get it onto the phone one of two ways.

**Option 1 (default) — download on the laptop, then send it to the phone.** Doing the
download on the laptop means it travels over **loopback** (`https://localhost`), which
nothing on the network can intercept, so you know the file is genuine before it ever
reaches the phone.

1. On the **laptop**, open (or download) `https://localhost:<port>/ca.crt` — the port
   from the banner, default **8443**. Chrome saves `petcam-ca.crt`. (On `localhost` it
   is safe to accept a one-time certificate warning; loopback can't be intercepted from
   the LAN.)
2. Send the file to the phone: **Quick Share / Nearby Share**, a USB cable, your file
   manager, or email it to yourself.
3. Install it on the phone: **Settings → Security → Encryption & credentials →
   Install a certificate → CA certificate**. Pick `petcam-ca.crt` and confirm.
   (Android's wording varies slightly by version.)
4. Do the **mandatory** name-and-fingerprint comparison below.

**Option 2 (fallback) — download on the phone over the LAN.** If you can't transfer the
file, open `https://<laptop-lan-ip>:<port>/ca.crt` **on the phone** (the banner prints
this exact URL; the **"Install this once on your phone so you never see a certificate
warning"** link on the PetCam login page points to the same file). Chrome downloads
`petcam-ca.crt` — install it as in Option 1, step 3. Because this download itself
travelled over the network, the fingerprint comparison below is the **only** thing
standing between you and a substituted certificate, so do it before trusting the CA.

### Compare the name and fingerprint (mandatory)

On the **laptop's banner** (the text `npm start` printed) find:

```
CA name: PetCam Local CA (<hostname>, YYYY-MM-DD HH:MM UTC)
CA SHA-256 fingerprint (must match exactly what your phone shows after installing;
if it differs, remove the certificate and do not continue):
  XX:XX:XX:XX:XX:XX:XX:XX
  XX:XX:XX:XX:XX:XX:XX:XX
  XX:XX:XX:XX:XX:XX:XX:XX
  XX:XX:XX:XX:XX:XX:XX:XX
```

Then on the phone open **Settings → Security → Encryption & credentials →
Trusted credentials → User**. Check that the installed certificate's name is exactly
the one from the banner, and that its SHA-256 fingerprint matches the banner
**exactly**.

### The rule you must not break

> **After installing the CA you should never see a certificate warning.**
> While you are installing it, the comparison above is the *only* protection — if an
> attacker on your network substitutes their own CA during that download, they get a
> root certificate that can intercept **all** of your phone's HTTPS traffic, not just
> PetCam.
>
> **If the SHA-256 fingerprint (or the name) in Settings → Trusted credentials → User
> does not match the laptop banner exactly, remove the certificate immediately and
> don't continue.**
>
> **Never click through a "Your connection is not private" warning.** A cert warning
> means something is wrong with your trust setup — or an attack. Don't proceed and
> don't enter your password; fix the CA trust first.
>
> If a certificate named `PetCam Local CA` is already installed from an **earlier**
> setup, remove it: keep only the one whose name and SHA-256 fingerprint exactly match
> the current banner, and remove the others (Trusted credentials → User → the CA →
> Remove). A recreated CA gets a new name that includes its creation date and time, so
> the current one is recognisable.

(On the laptop itself it is fine to accept a one-time warning for `https://localhost`
— loopback traffic can't be intercepted from the LAN. Importing the CA into Chrome's
own certificate settings on the laptop is optional.)

### Alternative — use your own certificate with mkcert

If you'd rather not install the PetCam CA, you can use [mkcert](https://github.com/FiloSottile/mkcert)
to issue a certificate for the laptop and trust mkcert's root on the phone:

```bash
# On the laptop:
mkcert -install
mkcert -cert-file petcam.pem -key-file petcam-key.pem \
  localhost <laptop-hostname> <laptop-hostname>.local <laptop-lan-ip>
```

Then point PetCam at it (see [`../README.md`](../README.md#configuration)):

```bash
export PETCAM_TLS_CERT="$PWD/petcam.pem"
export PETCAM_TLS_KEY="$PWD/petcam-key.pem"
npm start
```

With your own certificate, `/ca.crt` is not served (it returns 404) and the fingerprint
comparison above does not apply — you trust mkcert's root instead. Both paths are read as
documented (`src/server/tls.ts`). Installing mkcert's root on Android uses the same
"CA certificate" flow as above; confirm it on your phone with the
[first-time checklist](#first-time-on-your-phone).

---

## One-time step 2 — Let Chrome's media through the firewall

PetCam's video and audio travel directly between the laptop and the phone over **UDP**
(WebRTC). If the laptop's firewall blocks those inbound UDP packets, the call connects
but stays blank or "connecting". Chrome picks an **ephemeral UDP port** for each
session, so the rule is a UDP port range rather than a single port.

The exact range and rule depend on your OS — confirm them on your machine (see the
[first-time checklist](#first-time-on-your-phone)). The test plan suggests:

```bash
# nftables (Debian/Ubuntu/Fedora, etc.)
sudo nft add rule inet filter input udp dport 49152-65535 accept

# ufw alternative — allow UDP from your phone's LAN/VPN subnet, e.g. 192.168.1.0/24:
sudo ufw allow from 192.168.1.0/24 proto udp
```

Notes:
- Scope the rule to your **LAN/VPN subnet** if you can, rather than the whole internet
  (the laptop is not exposed to the internet in any case — PetCam is LAN/VPN only).
- If UDP simply cannot pass on your network, see the note on a relay in
  [`ARCHITECTURE.md`](ARCHITECTURE.md) §11 (out of scope for v1).
- Confirm the laptop's VPN client or network profile isn't overriding these rules.

---

## One-time step 3 — Keep the laptop awake and the station tab visible

The station is a browser tab. Chrome throttles or discards background tabs, and the OS
can sleep the machine, which kills the camera feed while you're out. Set this up once:

### Laptop power, lid and sleep

- Plug the laptop into **AC power** whenever you're relying on PetCam.
- Set the OS to **never sleep, never hibernate, and never turn off the display while
  on AC power**. Examples:
  - Linux/GNOME: Settings → Power → *Screen Blank* = Never, *Automatic Suspend* = Off.
  - Linux/macOS terminal alternative: run the server (and keep the session) under
    `systemd-inhibit`, e.g.
    `systemd-inhibit --what=idle:sleep --why="PetCam station" npm start`.
  - macOS: `caffeinate -dimsu npm start`, and System Settings → Lock Screen → disable
    sleep on power adapter.
- **Closing the lid** usually suspends the laptop. Either leave the lid open, or change
  the "when the lid is closed" behaviour for AC power (GNOME: Tweaks → *Lid close
  action*; or edit `logind.conf` → `HandleLidSwitchExternalPower=ignore`).
- A screen lock is fine **as long as** the station tab keeps running in the
  background; the safest option is to leave the station tab visible on its own.

### Keep the station tab visible

- Give the station its **own window** and leave it visible (Chrome throttles hidden
  tabs). Full-screen is fine.
- PetCam holds a **Screen Wake Lock** while the station runs, to stop the display
  sleeping, and re-acquires it when the tab becomes visible again. It is best-effort:
  some browsers drop the lock when the tab is hidden, so keep the tab visible anyway.
- **Do not** put the station behind another full-screen app or minimise its window.
- After a reboot, open the station again and click **Start station** (the station does
  not auto-start).

---

## First-time on your phone

Do these once, on your own phone and laptop. They are the steps that depend on your
device and OS, so confirm each one yourself rather than trusting the guide blindly.

- [ ] **CA file came from the laptop** — you downloaded `petcam-ca.crt` on the laptop
      from `https://localhost:<port>/ca.crt` ([Option 1](#install-the-petcam-ca-on-android)).
- [ ] **Name and fingerprint match** — on the phone, the installed CA's name is
      `PetCam Local CA (<hostname>, YYYY-MM-DD HH:MM UTC)` and its SHA-256 fingerprint
      matches the laptop banner **exactly**. If either differs: remove the certificate
      and stop ([step 1](#one-time-step-1--trust-the-certificate)).
- [ ] **No certificate warning** — opening the phone URL shows no warning. If it warns,
      stop and don't enter the password.
- [ ] **mkcert alternative** (only if you chose it) — mkcert's root is installed and
      trusted on Android (same "CA certificate" flow).
- [ ] **Firewall / UDP** — Chrome's inbound UDP reaches the laptop
      ([step 2](#one-time-step-2--let-chromes-media-through-the-firewall)); the exact
      port range is OS-specific, so confirm it on your machine.
- [ ] **Laptop power** — never sleep/hibernate on AC, lid behaviour set, station tab kept
      visible ([step 3](#one-time-step-3--keep-the-laptop-awake-and-the-station-tab-visible)).
- [ ] **On-device UI** — video autoplays (muted), **Tap for sound** unmutes it,
      **Talk**/**Push to talk** ask for camera/mic once, and the buttons/status wording
      match this guide. Note anything that differs and hand it to the dev lead.

---

## Day-to-day use

### On the laptop (the station)

1. Open `https://localhost:8443/station` in Chrome. (The station is **laptop-only**;
   opening it from the phone is refused by design.)
2. Sign in if asked, then click **Start station**. Allow **camera and microphone**
   access when Chrome asks — this is the one gesture that unlocks unattended sound
   playback too.
3. Leave the tab open and visible. It shows **Idle** until your phone connects; that's
   expected.
4. When your phone connects, the status becomes **"Phone connected"**, then
   **"Camera live"**, and while you **Talk** it shows **"Your person is talking"** with
   full-screen video + audio.
5. Click **Stop station** to release the camera/mic. (You'll need **Start station**
   again, and one tap to re-allow if the browser asks.)

If sound from your phone is blocked, the station shows an **Enable sound** button — tap
it once on the laptop.

### On the phone (the viewer)

Open the `https://<laptop-lan-ip>:8443/` URL from the banner, sign in, and:

| Control | What it does |
|---|---|
| **Live video** | Plays automatically as soon as the station is online (muted by default, because phones block autoplay-with-sound). |
| **Tap for sound** | Tap to unmute the laptop's microphone/audio in the viewer. |
| **Talk** | Sends your **phone camera + mic** to the laptop, which shows you full-screen with sound. Chrome will ask for camera+mic permission the first time. |
| **Push to talk** | Sends **mic only**, while you hold the button (keyboard: hold Space/Enter). Good when the laptop speakers would feed back into your mic. |
| **Stop talking** | Ends Talk/PTT and releases the phone's camera/mic. |
| **Reconnect** | Appears after relevant disconnects (e.g. "Opened elsewhere"); tap to take the session back. |

Behaviour worth knowing:
- **"Station offline"** means the laptop tab isn't connected — open the station there
  and click **Start station**.
- Talk and PTT are **disabled until the live view connects** (they need an active peer).
- If another device opens the same page (**"Opened elsewhere"**), the **newest wins**;
  the older one stops and offers **Reconnect** (it won't fight automatically).
- A password change (`npm run set-password`) or session revoke (`npm run revoke-sessions`)
  logs everyone out and returns both pages to the sign-in screen; sign in again. This is
  live — the running server reloads and closes open connections, no restart needed.
- The password is **at least 12 characters** (set or change it on the laptop with
  `npm run set-password`). Sessions use a signed cookie named `__Host-petcam_session`.

The labels above match the current pages ("Tap for sound", "Talk", "Push to talk",
"Stop talking", "Reconnect"; station: "Start station", "Stop station", "Enable sound",
"Your person is talking", "Camera live", "Idle"). Autoplay, the permission prompt and
the status wording depend on your phone — confirm them once with the
[first-time checklist](#first-time-on-your-phone).

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Your connection is not private" on the phone | CA not installed / wrong CA | Re-do [One-time step 1](#one-time-step-1--trust-the-certificate). **Do not** click through and type the password. If the fingerprint won't match, remove the cert and stop. |
| Login rejected | Wrong password | Use the current password. After `set-password`, sign in again everywhere. Too many tries → wait out the 15-minute limit. |
| Viewer: "Your station is offline" | Station tab closed / not started / laptop asleep | On the laptop, open `https://localhost:8443/station` and click **Start station**. Check power/sleep settings (step 3). |
| Viewer connects but is black/blank | UDP blocked, or camera permission denied on the laptop | Allow inbound UDP (step 2); on the laptop, re-grant camera/mic. |
| Video plays but no sound on the phone | Autoplay/policy or muted | Tap **Tap for sound**. Making the phone's first interaction with the page a tap also helps. |
| Laptop plays no sound when you Talk | Autoplay was never unlocked | On the laptop, click **Enable sound** (or **Stop station** → **Start station**, which re-does the unlocking click). |
| Feedback/howling when you Talk | Phone on speaker + laptop speakers | Use **Push to talk** (half-duplex), or lower the volume. |
| Black video after switching Wi-Fi/VPN on the phone | Old session replaced | Tap **Reconnect**, or reload the viewer page and sign in. |
| "Opened elsewhere" | Same page open on two devices | Tap **Reconnect** on the one you want to use. |
| `EADDRINUSE` on `npm start` | Port 8443 already in use | Start with another port: `PETCAM_PORT=8543 npm start`. Don't kill whatever holds the old port. |
| Cert warning keeps coming back | Your own (mkcert) cert expired, or the CA was removed | Re-issue/re-trust the cert. The built-in cert auto-renews and keeps the same CA, so it should not recur once CA trust is set. |
| Everything works for a while, then dies | Laptop slept, or the tab got hidden/throttled | Fix step 3; keep the station tab visible and the laptop on AC. |

---

## Real-phone acceptance checklist

Run this **on your actual phone over the home VPN** — it is the one part the
developer/QA team cannot test for you (they have no phone). Adapted from
`docs/TEST_PLAN.md` §6.

| # | Check | ✅ |
|---|---|---|
| 0 | You installed `petcam-ca.crt` as a **CA certificate**, its **SHA-256 fingerprint matches the laptop banner exactly**, and its name is `PetCam Local CA (<hostname>, YYYY-MM-DD HH:MM UTC)` from the banner. | ☐ |
| 1 | Opening the phone URL shows **no certificate warning**. (If it warns: stop, don't enter the password.) | ☐ |
| 2 | Phone opens `https://<laptop-lan-ip>:8443/`, login succeeds, and **live laptop video + audio appear within ~3 s**. | ☐ |
| 3 | `chrome://webrtc-internals` (optional) shows the connection as **connected** without needing a relay. | ☐ |
| 4 | **Talk** works: the phone asks for camera/mic once, and the laptop shows the phone full-screen **with audio**. | ☐ |
| 5 | **Push to talk** works: holding the button plays your voice on the laptop; releasing stops it. | ☐ |
| 6 | **Stop talking** releases the phone's camera/mic. | ☐ |
| 7 | Walking away and tapping **Talk** later still plays on the laptop **with no extra click on the laptop** (the single "Start station" gesture was enough). | ☐ |
| 8 | Restarting the server (or a momentary network blip) recovers by itself — video resumes without reloading. | ☐ |
| 9 | After **set-password**/**revoke-sessions**, both ends are logged out live (the server closes their connections) and must sign in again, with no restart. | ☐ |
| 10 | Leave the station open **overnight** (laptop on AC, sleep disabled); next morning the phone still gets live video, no "Station offline". | ☐ |
| 11 | Phone on **speaker** (not headset): tapping **Talk** and speaking does not produce loud feedback/howling. If it does, note it — the fallback is to use Push to talk. | ☐ |

If a check fails, note which one and hand the list back to the dev lead.
