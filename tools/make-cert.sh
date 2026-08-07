#!/bin/sh
# Self-signed certificate for serving the app to other machines on the LAN.
# Browsers only allow camera access in a secure context: localhost qualifies,
# http://<lan-ip> does not. Accept the warning once and the origin counts.
set -e
cd "$(dirname "$0")/.."
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
mkdir -p .certs
cat > .certs/openssl.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = overhead-scanner.local
[v3]
subjectAltName = @alt
basicConstraints = CA:FALSE
extendedKeyUsage = serverAuth
[alt]
IP.1 = $IP
IP.2 = 127.0.0.1
DNS.1 = localhost
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout .certs/key.pem -out .certs/cert.pem -config .certs/openssl.cnf 2>/dev/null
echo "certificate for $IP written to .certs/"
echo "now run:  python3 tools/serve-https.py 8443"
echo "then open https://$IP:8443 on the other machine"
