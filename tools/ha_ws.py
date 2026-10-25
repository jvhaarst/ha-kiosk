#!/usr/bin/env python3
"""Minimal Home Assistant WebSocket client, stdlib only (plus ssl for wss)."""

import base64
import json
import os
import socket
import ssl
import struct
import sys
import urllib.parse


class WS:
    def __init__(self, url, timeout=20.0):
        p = urllib.parse.urlparse(url)
        host = p.hostname
        port = p.port or (443 if p.scheme == "wss" else 80)
        path = p.path or "/"
        sock = socket.create_connection((host, port), timeout=timeout)
        if p.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        self.s = sock
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode())
        while b"\r\n\r\n" not in self.buf:
            c = self.s.recv(4096)
            if not c:
                raise RuntimeError("closed during handshake")
            self.buf += c
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(head.split(b"\r\n")[0].decode())

    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise RuntimeError("closed while reading")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        payload = json.dumps(obj).encode()
        h = bytearray([0x81])
        n = len(payload)
        if n < 126:
            h.append(0x80 | n)
        elif n < 1 << 16:
            h.append(0x80 | 126)
            h += struct.pack(">H", n)
        else:
            h.append(0x80 | 127)
            h += struct.pack(">Q", n)
        m = os.urandom(4)
        h += m
        self.s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        chunks = []
        while True:
            a, b = self._read(2)
            fin, op, ln = a & 0x80, a & 0x0F, b & 0x7F
            if ln == 126:
                (ln,) = struct.unpack(">H", self._read(2))
            elif ln == 127:
                (ln,) = struct.unpack(">Q", self._read(8))
            data = self._read(ln) if ln else b""
            if op == 0x8:
                raise RuntimeError("peer closed")
            if op in (0x9, 0xA):
                continue
            chunks.append(data)
            if fin:
                return json.loads(b"".join(chunks).decode())


def main():
    url = os.environ["HA_WS_URL"]
    token = os.environ["HA_TOKEN"]
    ws = WS(url)
    msg = ws.recv()
    assert msg["type"] == "auth_required", msg
    ws.send({"type": "auth", "access_token": token})
    msg = ws.recv()
    if msg["type"] != "auth_ok":
        print("AUTH FAILED:", msg, file=sys.stderr)
        return 1
    print(f"auth_ok (HA {msg.get('ha_version')})", file=sys.stderr)

    commands = json.load(sys.stdin)
    for next_id, cmd in enumerate(commands, start=1):
        cmd = dict(cmd, id=next_id)
        ws.send(cmd)
        while True:
            r = ws.recv()
            if r.get("id") == next_id:
                break
        print(
            json.dumps(
                {
                    "cmd": cmd["type"],
                    "ok": r.get("success"),
                    "result": r.get("result"),
                    "error": r.get("error"),
                }
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
