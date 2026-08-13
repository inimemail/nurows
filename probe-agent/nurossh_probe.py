#!/usr/bin/env python3
import concurrent.futures
import json
import ipaddress
import os
import platform
import socket
import subprocess
import time
import urllib.request
from urllib.parse import urlparse

CONFIG_PATH = os.environ.get("NUROSSH_PROBE_CONFIG", "/etc/nurossh-probe/config.json")
VERSION = "1.0.0"


def validate_target_address(address, allow_private=False):
    results = socket.getaddrinfo(address, None, type=socket.SOCK_STREAM)
    addresses = {item[4][0].split("%")[0] for item in results}
    if not addresses:
        raise RuntimeError("target did not resolve")
    for value in addresses:
        ip = ipaddress.ip_address(value)
        metadata = value in {"169.254.169.254", "100.100.100.200"}
        forbidden = ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved or metadata
        if forbidden or (not allow_private and ip.is_private):
            raise RuntimeError("target address is not allowed")
    return addresses


def request(config, method, pathname, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(config["server"] + pathname, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if config.get("secret"):
        req.add_header("Authorization", "Bearer " + config["secret"])
        req.add_header("X-Probe-Id", config["probeId"])
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def register(config):
    result = request(config, "POST", "/probe/register", {
        "probeId": config["probeId"],
        "token": config["token"]
    })
    config["secret"] = result["agentSecret"]
    config.pop("token", None)
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(config, handle)
    os.chmod(CONFIG_PATH, 0o600)


def check_target(target):
    started = time.monotonic()
    try:
        addresses = validate_target_address(target["address"], bool(target.get("allowPrivate")))
        timeout = float(target.get("timeout", 5))
        if target.get("checkType") == "ping":
            is_windows = platform.system().lower() == "windows"
            count_flag = "-n" if is_windows else "-c"
            timeout_flag = "-w" if is_windows else "-W"
            timeout_value = str(int(timeout * (1000 if is_windows else 1)))
            success = False
            for address in addresses:
                family = ipaddress.ip_address(address).version
                family_flag = "-6" if family == 6 and not is_windows else ("-4" if family == 4 and not is_windows else None)
                command = ["ping"] + ([family_flag] if family_flag else []) + [count_flag, "1", timeout_flag, timeout_value, address]
                completed = subprocess.run(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=timeout + 2,
                    check=False
                )
                if completed.returncode == 0:
                    success = True
                    break
            if not success:
                raise RuntimeError("ping failed")
        else:
            last_error = None
            for address in addresses:
                try:
                    with socket.create_connection((address, int(target.get("port", 443))), timeout=timeout):
                        last_error = None
                        break
                except OSError as error:
                    last_error = error
            if last_error:
                raise last_error
        return {"targetId": target["id"], "ok": True, "latencyMs": round((time.monotonic() - started) * 1000, 2), "error": ""}
    except Exception as error:
        return {"targetId": target["id"], "ok": False, "latencyMs": round((time.monotonic() - started) * 1000, 2), "error": str(error)[:200]}


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    parsed_server = urlparse(str(config.get("server", "")))
    if parsed_server.scheme != "https" and parsed_server.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("probe server must use https")
    if not config.get("secret"):
        register(config)
    schedules = {}
    while True:
        try:
            payload = request(config, "GET", "/probe/config")
            targets = payload.get("targets", [])
            now = time.time()
            due = [target for target in targets if now >= schedules.get(target["id"], 0)]
            if due:
                workers = min(max(1, int(config.get("maxConcurrency", 100))), len(due))
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
                    results = list(executor.map(check_target, due))
                request(config, "POST", "/probe/report", {"version": VERSION, "results": results})
                for target in due:
                    schedules[target["id"]] = now + max(5, int(target.get("interval", 30)))
            request(config, "POST", "/probe/heartbeat", {"version": VERSION})
        except Exception:
            time.sleep(10)
        time.sleep(5)


if __name__ == "__main__":
    main()
