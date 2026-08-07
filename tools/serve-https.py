#!/usr/bin/env python3
"""HTTPS for the LAN, so getUserMedia works from another machine.

Run tools/make-cert.sh first. Certificates live in .certs/ and are gitignored
— a private key must never be committed.

Browsers only allow camera access in a secure context. localhost counts;
http://<lan-ip> does not. A self-signed certificate is enough — the browser
warns once, you accept, and the origin is then treated as secure.
"""
import functools, http.server, ssl, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
here = os.path.join(ROOT, '.certs')

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(os.path.join(here, 'cert.pem'), os.path.join(here, 'key.pem'))
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print('serving %s on https://0.0.0.0:%d' % (ROOT, PORT), flush=True)
httpd.serve_forever()
