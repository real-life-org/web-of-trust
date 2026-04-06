# wot-fdroid — Self-hosted F-Droid Repository

Statischer Fileserver (Caddy) für das F-Droid App-Repository.

## Verzeichnisstruktur

```
wot-fdroid/
├── Caddyfile              # Caddy Config
├── docker-compose.yml     # Container-Definition
└── fdroid/                # F-Droid Arbeitsverzeichnis
    ├── config.yml         # F-Droid Server Config (gitignored)
    ├── keystore.p12       # Signing Key (gitignored)
    ├── metadata/          # App-Beschreibungen
    └── repo/              # APKs + Index (von fdroid update generiert)
```

## Live

- **URL:** https://fdroid.utopia-lab.org/fdroid/repo
- **Fingerprint:** `83:71:F8:DE:A9:C3:F7:C1:04:46:0A:B7:D8:C7:D2:43:24:45:AB:28:FD:83:BE:AF:E0:DB:5C:83:5B:02:0A:87`

## Server-Setup

```bash
# Auf dem Server (einmalig)
docker compose up -d
# Zentraler Caddy: fdroid.utopia-lab.org → reverse_proxy wot-fdroid:80
```

## Neues Release veröffentlichen

```bash
cd packages/wot-fdroid

# 1. APK in fdroid/repo/ kopieren
cp ../../apps/demo/android/app/build/outputs/apk/fdroid/release/app-fdroid-release.apk \
   fdroid/repo/org.reallife.weboftrust_<VERSION_CODE>.apk

# 2. Index aktualisieren (aus fdroid/ Verzeichnis!)
cd fdroid
export PATH="$ANDROID_HOME/build-tools/36.0.0:$PATH"
fdroid update

# 3. Auf Server deployen
# Per FileZilla: fdroid/ Ordner auf den Server hochladen
# Oder: rsync -av fdroid/ user@server:/path/to/wot-fdroid/fdroid/
```

## In F-Droid App hinzufügen

Settings → Repositories → Add:
```
https://fdroid.utopia-lab.org/fdroid/repo
```

## Sicherheit

- `keystore.p12` und `config.yml` liegen in `fdroid/` und sind per `.gitignore` ausgeschlossen
- Der Keystore darf **niemals** committet oder öffentlich zugänglich gemacht werden
- **Backup den Keystore!** Bei Verlust müssen alle Nutzer das Repo neu hinzufügen
