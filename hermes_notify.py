#!/usr/bin/env python3
"""Send a signed Hermes notification through a restricted SSH port forward."""

import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


class NotificationError(Exception):
    pass


def send(title: str, content: str, *, route: str, environment=None) -> None:
    env = os.environ if environment is None else environment
    key = env.get("HERMES_WEBHOOK_SSH_KEY", "")
    secret = env.get("HERMES_WEBHOOK_SECRET", "")
    if not key or not secret:
        raise NotificationError("Hermes GitHub Secrets are missing")
    if not route or not all(ch.isascii() and (ch.isalnum() or ch == "-") for ch in route):
        raise NotificationError("Invalid webhook route")

    body = json.dumps({"title": title, "content": content}, ensure_ascii=False, separators=(",", ":")).encode()
    if len(title) + len(content) > 3800:
        raise NotificationError("Notification exceeds the supported message size")
    host_keys = Path(__file__).resolve().parent / ".github" / "oracle_ssh_known_hosts"
    if not host_keys.is_file():
        raise NotificationError("Pinned SSH host key is missing")

    with tempfile.TemporaryDirectory(prefix="hermes-notify-") as directory:
        key_path = Path(directory) / "id_ed25519"
        key_path.write_text(key.rstrip("\n") + "\n")
        key_path.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cmd = ["ssh", "-N", "-i", str(key_path), "-o", "IdentitiesOnly=yes",
               "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", f"UserKnownHostsFile={host_keys}", "-o", "ExitOnForwardFailure=yes",
               "-o", "ConnectTimeout=12", "-L", f"127.0.0.1:{port}:127.0.0.1:8644",
               "ubuntu@" + "oracleusphoenix.duckdns.org"]
        # The SSH process receives no check-in account credentials or webhook secret.
        ssh_env = {name: env[name] for name in ("PATH", "HOME", "LANG") if name in env}
        process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=ssh_env)
        try:
            url = f"http://127.0.0.1:{port}/webhooks/{route}"
            for _ in range(30):
                if process.poll() is not None:
                    raise NotificationError("Restricted SSH connection failed")
                try:
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                            f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.2)
            else:
                raise NotificationError("Hermes webhook did not become ready")

            timestamp = str(int(time.time()))
            signature = hmac.new(secret.encode(), timestamp.encode() + b"." + body,
                                 hashlib.sha256).hexdigest()
            request = urllib.request.Request(url, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "X-Webhook-Timestamp": timestamp,
                "X-Webhook-Signature-V2": signature,
                "X-Request-ID": uuid.uuid4().hex,
            })
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                        request, timeout=25) as response:
                    result = json.load(response)
                    if response.status != 200 or result.get("status") != "delivered":
                        raise NotificationError("Hermes did not confirm delivery")
            except (OSError, urllib.error.URLError, ValueError):
                raise NotificationError("Hermes notification was not confirmed") from None
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
