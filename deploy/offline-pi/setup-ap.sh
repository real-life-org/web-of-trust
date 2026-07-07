#!/usr/bin/env bash
# Richtet auf dem Raspberry Pi (NetworkManager) ein OFFENES WLAN (Access Point)
# OHNE Internet ein. NM bringt im "shared"-Modus DHCP + lokales DNS gleich mit.
#
# Ergebnis:
#   SSID:    wot-demo  (offen, kein Passwort)
#   Pi-IP:   192.168.4.1
#   Clients: bekommen 192.168.4.x per DHCP
#
# Passwort gewünscht? wifi-sec.key-mgmt wpa-psk + wifi-sec.psk <pw> ergänzen.
#
# Aufruf:  sudo bash setup-ap.sh
set -euo pipefail

SSID="wot-demo"
CON="wot-ap"
PI_IP="192.168.4.1/24"

# Bestehendes Profil entfernen (idempotent)
nmcli connection delete "$CON" 2>/dev/null || true

# Offenes AP-Profil anlegen (keine wifi-sec = offen)
nmcli connection add type wifi ifname wlan0 con-name "$CON" autoconnect yes ssid "$SSID"
nmcli connection modify "$CON" \
  802-11-wireless.mode ap \
  802-11-wireless.band bg \
  802-11-wireless.channel 6 \
  ipv4.method shared \
  ipv4.addresses "$PI_IP"

nmcli connection up "$CON"

echo
echo "Access Point aktiv (offen):"
echo "  SSID:  $SSID"
echo "  Pi-IP: ${PI_IP%/*}"
echo
echo "Test vom Pi aus, sobald die Dienste laufen:"
echo "  curl http://192.168.4.1:8788/health"
echo "  curl http://192.168.4.1:8789/health"
