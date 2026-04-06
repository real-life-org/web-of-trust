# wot-fdroid — Self-hosted F-Droid Repository

Statischer Fileserver (Caddy) für das F-Droid App-Repository.

## Architektur

- Eigener Caddy-Container serviert `./repo/` als statische Dateien
- Zentraler Caddy reverse-proxied `fdroid.utopia-lab.org` → `wot-fdroid:80`
- F-Droid Repo wird **lokal** gebaut und per rsync auf den Server kopiert

## Live

- **URL:** https://fdroid.utopia-lab.org/repo
- **Fingerprint:** `83:71:F8:DE:A9:C3:F7:C1:04:46:0A:B7:D8:C7:D2:43:24:45:AB:28:FD:83:BE:AF:E0:DB:5C:83:5B:02:0A:87`

## Server-Setup

```bash
# Auf dem Server (einmalig)
docker compose up -d
# Zentraler Caddy: fdroid.utopia-lab.org → reverse_proxy wot-fdroid:80
```

## Neues Release veröffentlichen

```bash
# 1. APK bauen (im web-of-trust Root)
./scripts/build-fdroid-apk.sh

# 2. APK signieren (im packages/wot-fdroid Verzeichnis)
APKSIGNER=$ANDROID_HOME/build-tools/36.0.0/apksigner
PASS=$(grep keystorepass repo/config.yml | awk '{print $2}')
ALIAS=$(keytool -list -keystore repo/keystore.p12 -storetype PKCS12 -storepass $PASS 2>/dev/null | grep PrivateKeyEntry | cut -d, -f1)

$APKSIGNER sign \
  --ks repo/keystore.p12 \
  --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" \
  --key-pass "pass:$PASS" \
  --out repo/repo/org.reallife.weboftrust_<VERSION_CODE>.apk \
  ../../apps/demo/android/app/build/outputs/apk/release/app-release-unsigned.apk

# 3. Repo-Index aktualisieren
cd repo && fdroid update

# 4. Auf Server deployen
rsync -av repo/ user@server:/path/to/wot-fdroid/repo/
```

## In F-Droid App hinzufügen

Settings → Repositories → Add:
```
https://fdroid.utopia-lab.org/repo
```

## Sicherheit

- `keystore.p12` und `config.yml` liegen in `repo/` aber sind per `.gitignore` ausgeschlossen
- Der Keystore darf **niemals** committet oder öffentlich zugänglich gemacht werden
- **Backup den Keystore!** Bei Verlust müssen alle Nutzer das Repo neu hinzufügen
