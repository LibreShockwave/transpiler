#!/usr/bin/env python3
"""Simple CORS-enabled HTTP static file server."""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIR = sys.argv[2] if len(sys.argv) > 2 else "."

os.chdir(DIR)

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def log_message(self, format, *args):
        pass  # quiet

with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
    print(f"Serving {DIR} on port {PORT} with CORS")
    httpd.serve_forever()
