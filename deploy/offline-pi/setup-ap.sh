#!/usr/bin/env bash
# Richtet auf dem Raspberry Pi (Raspberry Pi OS Bookworm, 64-bit) einen
# WLAN-Access-Point OHNE Internet ein. NetworkManager (Standard ab Bookworm)
# bringt im "shared"-Modus DHCP + lokales DNS gleich mit.
#
# Ergebnis:
#   SSID:      wot-demo
#   Passwort:  realtrust   (mind. 8 Zeichen, anpassen!)
#   Pi-IP:     192.168.4.1
#   Clients:   bekommen 192.168.4.x per DHCP
#
# Aufruf:  sudo bash setup-ap.sh
set -euo pipefail

SSID="wot-demo"
PASS="realtrust"
CON="wot-ap"
PI_IP="192.168.4.1/24"

# Bestehendes Profil entfernen (idempotent)
nmcli connection delete "$CON" 2>/dev/null || true

# AP-Profil anlegen
nmcli connection add type wifi ifname wlan0 con-name "$CON" autoconnect yes ssid "$SSID"
nmcli connection modify "$CON" \
  802-11-wireless.mode ap \
  802-11-wireless.band bg \
  ipv4.method shared \
  ipv4.addresses "$PI_IP" \
  wifi-sec.key-mgmt wpa-psk \
  wifi-sec.psk "$PASS"

nmcli connection up "$CON"

echo
echo "Access Point aktiv:"
echo "  SSID:     $SSID"
echo "  Passwort: $PASS"
echo "  Pi-IP:    ${PI_IP%/*}"
echo
echo "Test vom Pi aus, sobald die Dienste laufen:"
echo "  curl http://192.168.4.1:8788/health"
echo "  curl http://192.168.4.1:8789/health"
