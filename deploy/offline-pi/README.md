# Web of Trust — Offline-Demo-Box (Raspberry Pi)

Eine **internet-lose** WoT-Demo für Events (z.B. DWebcamp): Der Pi spannt ein
eigenes WLAN auf, betreibt darin Relay + Profiles + Vault, liefert eine
Landing-Page + die APK und die Web-App über **echtes TLS-Zertifikat**, und öffnet
beim Verbinden automatisch eine Startseite (Captive-Portal). Optional reicht er
Internet von einem USB-LTE-Stick durch.

---

## Überblick / Architektur

```
Gerät (Handy/Laptop)  ── WLAN: wot-demo (offen) ──►  Raspberry Pi (192.168.4.1)
                                                       ├─ hostapd/NM  (Access Point)
                                                       ├─ dnsmasq     (DHCP + DNS, *.box.web-of-trust.de → sich selbst)
                                                       ├─ Caddy :80/:443  (Landing, Web-App, TLS-Reverse-Proxy, Captive-Portal)
                                                       ├─ wot-relay    :8787 (WebSocket)
                                                       ├─ wot-profiles :8788
                                                       └─ wot-vault    :8789
                                              (optional) └─ USB-LTE-Stick → Internet-Uplink (NAT)
```

**Domains** (nur im `wot-demo` auflösbar, Wildcard-Cert `*.box.web-of-trust.de`):

| URL | Inhalt |
|---|---|
| `https://box.web-of-trust.de/` | Landing-Page + APK-Download |
| `https://box.web-of-trust.de/wot.apk` | die native Android-App |
| `https://app.box.web-of-trust.de/` | Web-App (secure context, `crypto.subtle`) |
| `wss://relay.box.web-of-trust.de` | Relay (Proxy → `wot-relay:8787`) |
| `https://profiles.box.web-of-trust.de` | Profiles (Proxy → `:8788`) |
| `https://vault.box.web-of-trust.de` | Vault (Proxy → `:8789`) |

Warum echtes Cert: Die Web-App nutzt `crypto.subtle` und braucht daher einen
**secure context** (HTTPS). Ein selbstsigniertes Cert würde Warnungen erzeugen;
darum ein echtes Let's-Encrypt-**Wildcard** per DNS-01, lokal aufgelöst.

---

## Zugang (SSH)

- Nutzer `pi`, im `wot-demo` erreichbar unter `192.168.4.1` (bzw. über den
  Uplink-Router unter dessen LAN-IP).
- Ein Automations-Key liegt lokal: `~/.ssh/wot_pi_automation`
  → `ssh -i ~/.ssh/wot_pi_automation pi@192.168.4.1`

---

## Erstinstallation (Kurzfassung)

Das OS ist **Raspberry Pi OS Lite (trixie, cloud-init)** auf **SD-Karte**
(der Pi 4 bootet **nicht** zuverlässig von USB-Stick — SD nehmen).

Headless-Config über cloud-init auf der Boot-Partition (`user-data`): Hostname
`wot-box`, User `pi`, SSH an, WLAN-Region, und ein `runcmd`, das den Access
Point per `nmcli` anlegt. Danach:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker pi
docker compose -f deploy/offline-pi/docker-compose.offline.yml up -d --build
```

Der erste Build kompiliert `wot-core` + `better-sqlite3` (arm64) — auf dem Pi 4
~15–25 min, einmalig. Container haben `restart: unless-stopped` → Auto-Start
nach Reboot.

---

## Access Point (offenes WLAN)

Angelegt als NetworkManager-Profil `wot-ap` (SSID `wot-demo`, **offen**, feste
IP `192.168.4.1/24`, `ipv4.method shared` → DHCP + NAT):

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name wot-ap autoconnect yes \
  ssid wot-demo 802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 \
  ipv4.method shared ipv4.addresses 192.168.4.1/24
sudo nmcli connection up wot-ap
```

Passwort gewünscht? `wifi-sec.key-mgmt wpa-psk wifi-sec.psk <pw>` ergänzen.

---

## DNS (dnsmasq) — lokale Auflösung + Captive-Domains

NetworkManagers Shared-dnsmasq liest `/etc/NetworkManager/dnsmasq-shared.d/`
(nur beim Reaktivieren der Verbindung — `nmcli connection up wot-ap`, **kein**
SIGHUP).

- `wot-box.conf`: `address=/box.web-of-trust.de/192.168.4.1`
  (deckt die ganze Zone inkl. `app.`/`relay.`/`profiles.`/`vault.box…`)
- `captive.conf`: die OS-Connectivity-Check-Domains → `192.168.4.1`
  (`connectivitycheck.gstatic.com`, `connectivitycheck.android.com`,
  `captive.apple.com`, `www.msftconnecttest.com`, …)

---

## Caddy — TLS, Web, Reverse-Proxy, Captive-Portal

Siehe [web/Caddyfile](web/Caddyfile). Kernpunkte:

- `box…` liefert die Landing (`web/site`), `app.box…` die Web-App (`web/webapp`,
  SPA-Fallback), beide mit `tls /certs/box.crt /certs/box.key`.
- `relay/profiles/vault.box…` sind TLS-Reverse-Proxys auf die Container.
- **`:80`** beantwortet die OS-Connectivity-Checks mit „Internet vorhanden"
  (204 / Success) → **kein** Captive-Popup, aber Geräte meiden das `wot-demo`
  nicht. Liefert außerdem die Landing + APK auch unter `http://192.168.4.1/`.
  Der Zugang läuft bewusst über einen **ausgedruckten QR-Code** auf
  `https://box.web-of-trust.de/`, nicht über ein Auto-Popup.

Web-App/APK sind mit den TLS-Box-URLs gebaut, `web/certs/` wird gemountet.

---

## Zertifikat (Let's Encrypt Wildcard via INWX DNS-01)

Auf dem Pi mit `acme.sh` geholt (DNS-01, kein öffentlicher Port nötig):

```bash
export INWX_User='…'; read -rsp 'INWX PW: ' INWX_Password; echo; export INWX_Password
~/.acme.sh/acme.sh --issue --dns dns_inwx -d box.web-of-trust.de -d '*.box.web-of-trust.de' --server letsencrypt
~/.acme.sh/acme.sh --install-cert -d box.web-of-trust.de --ecc \
  --key-file  ~/wot-offline/deploy/offline-pi/web/certs/box.key \
  --fullchain-file ~/wot-offline/deploy/offline-pi/web/certs/box.crt \
  --reloadcmd "sudo docker restart wot-web"
```

> **⚠️ Renewal-Schuld:** Enthält das INWX-Passwort ein Anführungszeichen, zerlegt
> acme.sh die `account.conf` (`unexpected EOF`) → **Auto-Renewal scheitert**.
> Für Dauerbetrieb einen INWX-API-Zugang mit anführungszeichen-freiem Passwort
> nutzen. Das Cert selbst gilt 90 Tage.

---

## APK + Web-App bauen (mit Box-URLs)

Beide zeigen auf die **TLS-Box-Endpunkte** — nicht auf `ws://192.168.4.1`, weil
Android cleartext (`ws://`/`http://`) blockiert und die WebView-Herkunft `https`
ist (Mixed Content). TLS über den Pi-DNS + echtes Cert löst beides.

```bash
cd apps/demo
VITE_RELAY_URL=wss://relay.box.web-of-trust.de \
VITE_PROFILE_SERVICE_URL=https://profiles.box.web-of-trust.de \
VITE_VAULT_URL=https://vault.box.web-of-trust.de \
VITE_DISABLE_LIVE_UPDATE=1 VITE_BASE_PATH=/ \
pnpm build

# Web-App: dist/ → Pi web/webapp/
# APK:     npx cap sync android && (cd android && ./gradlew assembleFdroidDebug)
#          → android/app/build/outputs/apk/fdroid/debug/app-fdroid-debug.apk → Pi web/site/wot.apk
```

`VITE_DISABLE_LIVE_UPDATE=1` schaltet den OTA-Check ab (sonst tauscht die App das
Festival-Bundle gegen das Produktions-Bundle — [main.tsx](../../apps/demo/src/main.tsx)).

---

## Internet-Uplink (optional, USB-LTE-Stick)

Stick direkt in den Pi. **HiLink-Sticks** (Huawei E3372 & Co.) melden sich als
Netzwerk-Interface (`eth1`, `192.168.8.x`) → NetworkManager verbindet automatisch,
die Shared-Masquerade-Regel (`192.168.4.0/24 → masquerade`) folgt dem neuen
Default-Route → `wot-demo` bekommt Internet. Plug-and-play.

Serielle/QMI-Sticks brauchen `modemmanager` + `usb-modeswitch` (installiert).

> Beim Umstecken vom Router auf den Pi zusätzlich das **Ethernet ziehen**, sonst
> schattet die tote Router-Default-Route den Stick.

---

## Festival-Betrieb: Konnektivität ehrlich

Der Kern: **Handys meiden ein WLAN ohne Internet** und routen über Mobilfunk —
dann scheitert die App (Carrier-DNS kennt `*.box.web-of-trust.de` nicht). Modernes
Android macht zusätzlich einen **HTTPS-Probe** (`https://www.google.com/generate_204`),
den man **nicht** spoofen kann. Daraus folgt:

| Szenario | Web-App (Browser) | Native App |
|---|---|---|
| **LTE-Stick hat Empfang** (echtes Internet) | ✅ alle | ✅ alle |
| Kein Empfang, **eigene Demo-Geräte** | ✅ | ✅ (siehe unten) |
| Kein Empfang, **fremde Handys** | ✅ (empfohlen) | ⚠️ nur mit mobilen Daten aus |

**Empfehlungen:**
- **Stick mitnehmen** — schon wenig Empfang macht die Box für alle voll nutzbar.
- Für fremde Besucher ohne Empfang die **Web-App** in den Vordergrund stellen
  (läuft lokal, auch im Captive-Zustand) — Landing/QR zeigt „Open in Browser".
- **Eigene Demo-Handys** offline-fest machen (deaktiviert die Captive-Erkennung,
  Gerät meidet `wot-demo` nicht mehr; überlebt Reboot):
  ```bash
  adb shell settings put global captive_portal_mode 0   # zurück: … 1
  ```

---

## Vor-Ort-Checkliste

1. Pi an Strom (Powerbank/Powerstation), hochfahren → `wot-demo` erscheint.
2. (Optional) LTE-Stick in den Pi → `wot-demo` hat Internet.
3. Gerät mit `wot-demo` verbinden, dann **QR-Code scannen** (bzw.
   `https://box.web-of-trust.de/` öffnen) → Landing.
4. „Install the App" (APK) **oder** „Open in Browser" (Web-App).
5. Zwei Geräte, Space anlegen, verifizieren → Sync läuft rein lokal über den Pi.
6. Mitschauen: `http://192.168.4.1:8787/dashboard`.

---

## Reset zwischen Demos

```bash
docker compose -f deploy/offline-pi/docker-compose.offline.yml down -v
docker compose -f deploy/offline-pi/docker-compose.offline.yml up -d
```
