#!/usr/bin/env python3
import concurrent.futures
import json
import ipaddress
import os
import platform
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.error import HTTPError
from urllib.parse import urlparse

CONFIG_PATH = os.environ.get("NUROSSH_PROBE_CONFIG", "/etc/nurossh-probe/config.json")
VERSION = "1.3.0"
DEFAULT_CHECK_ROUNDS = 3
DEFAULT_ATTEMPTS_PER_ROUND = 3
MAX_CHECK_ROUNDS = 10
MAX_ATTEMPTS_PER_ROUND = 10
ROUND_DELAY_SECONDS = 1


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
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(config, handle)
    os.chmod(CONFIG_PATH, 0o600)


def check_address(target, address, timeout):
    timeout = max(0.1, float(timeout))
    if target.get("checkType") == "ping":
        is_windows = platform.system().lower() == "windows"
        count_flag = "-n" if is_windows else "-c"
        timeout_flag = "-w" if is_windows else "-W"
        timeout_value = str(max(1, int(timeout * 1000))) if is_windows else str(max(1, int(timeout + 0.999)))
        family = ipaddress.ip_address(address).version
        family_flag = "-6" if family == 6 and not is_windows else ("-4" if family == 4 and not is_windows else None)
        command = ["ping"] + ([family_flag] if family_flag else []) + [count_flag, "1", timeout_flag, timeout_value, address]
        completed = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False
        )
        if completed.returncode != 0:
            raise RuntimeError("ping failed")
        return
    with socket.create_connection((address, int(target.get("port", 443))), timeout=timeout):
        return


def check_attempt(target, addresses, timeout):
    deadline = time.monotonic() + max(0.1, float(timeout))
    last_error = "check failed"
    ordered_addresses = sorted(addresses)
    for index, address in enumerate(ordered_addresses):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False, "round timeout"
        address_timeout = remaining / max(1, len(ordered_addresses) - index)
        try:
            check_address(target, address, address_timeout)
            return True, ""
        except Exception as error:
            last_error = str(error) or error.__class__.__name__
    return False, last_error


def check_target(target):
    started = time.monotonic()
    try:
        timeout = max(1.0, float(target.get("timeout", 5)))
    except (TypeError, ValueError):
        timeout = 5.0
    try:
        check_rounds = min(MAX_CHECK_ROUNDS, max(1, int(target.get("checkRounds", DEFAULT_CHECK_ROUNDS))))
    except (TypeError, ValueError):
        check_rounds = DEFAULT_CHECK_ROUNDS
    try:
        attempts_per_round = min(MAX_ATTEMPTS_PER_ROUND, max(1, int(target.get("attemptsPerRound", DEFAULT_ATTEMPTS_PER_ROUND))))
    except (TypeError, ValueError):
        attempts_per_round = DEFAULT_ATTEMPTS_PER_ROUND
    attempts_run = 0
    rounds_completed = 0
    addresses = None
    last_error = "check failed"
    for round_index in range(1, check_rounds + 1):
        round_deadline = time.monotonic() + timeout
        for attempt_index in range(1, attempts_per_round + 1):
            attempts_run += 1
            try:
                if addresses is None:
                    addresses = validate_target_address(target["address"], bool(target.get("allowPrivate")))
                remaining = round_deadline - time.monotonic()
                attempts_left = attempts_per_round - attempt_index + 1
                if remaining <= 0:
                    raise TimeoutError("round timeout")
                ok, error = check_attempt(target, addresses, remaining / attempts_left)
                if ok:
                    return {
                        "targetId": target["id"], "ok": True,
                        "latencyMs": round((time.monotonic() - started) * 1000, 2), "error": "",
                        "rounds": check_rounds, "attemptsPerRound": attempts_per_round,
                        "roundsCompleted": round_index, "attempts": attempts_run,
                        "successfulRound": round_index, "successfulAttempt": attempt_index,
                        "resolvedAddresses": sorted(addresses)
                    }
                last_error = error
            except Exception as error:
                addresses = None
                last_error = str(error) or error.__class__.__name__
        rounds_completed = round_index
        if round_index < check_rounds:
            time.sleep(ROUND_DELAY_SECONDS)
    return {
        "targetId": target["id"], "ok": False,
        "latencyMs": round((time.monotonic() - started) * 1000, 2),
        "error": f"{check_rounds} rounds x {attempts_per_round} attempts failed: {last_error}"[:200],
        "rounds": check_rounds, "attemptsPerRound": attempts_per_round,
        "roundsCompleted": rounds_completed, "attempts": attempts_run,
        "successfulRound": 0, "successfulAttempt": 0,
        "resolvedAddresses": sorted(addresses or [])
    }


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    parsed_server = urlparse(str(config.get("server", "")))
    if parsed_server.scheme != "https" and parsed_server.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("probe server must use https")
    if not config.get("secret"):
        register(config)
    schedules = {}
    check_now_markers = {}
    while True:
        try:
            payload = request(config, "GET", "/probe/config")
            targets = payload.get("targets", [])
            now = time.time()
            for target in targets:
                marker = str(target.get("checkNowAt", ""))
                if marker and check_now_markers.get(target["id"]) != marker:
                    check_now_markers[target["id"]] = marker
                    schedules[target["id"]] = 0
            due = [target for target in targets if now >= schedules.get(target["id"], 0)]
            if due:
                workers = min(max(1, int(config.get("maxConcurrency", 100))), len(due))
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
                    results = list(executor.map(check_target, due))
                request(config, "POST", "/probe/report", {"version": VERSION, "results": results})
                for target in due:
                    schedules[target["id"]] = now + max(5, int(target.get("interval", 30)))
            request(config, "POST", "/probe/heartbeat", {"version": VERSION})
        except HTTPError as error:
            if error.code == 401 and config.get("token") and config.get("secret"):
                config.pop("secret", None)
                try:
                    register(config)
                except Exception as register_error:
                    print(f"probe registration failed after authentication loss: {register_error}", file=sys.stderr, flush=True)
            else:
                print(f"probe request failed with HTTP {error.code}", file=sys.stderr, flush=True)
            time.sleep(10)
        except Exception as error:
            print(f"probe loop error: {error}", file=sys.stderr, flush=True)
            time.sleep(10)
        time.sleep(5)


if __name__ == "__main__":
    main()
