#!/usr/bin/env python3
import concurrent.futures
import json
import ipaddress
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.error import HTTPError
from urllib.parse import quote, urlparse

CONFIG_PATH = os.environ.get("NUROSSH_PROBE_CONFIG", "/etc/nurossh-probe/config.json")
VERSION = "1.4.10"
DEFAULT_CHECK_ROUNDS = 3
DEFAULT_ATTEMPTS_PER_ROUND = 3
MAX_CHECK_ROUNDS = 10
MAX_ATTEMPTS_PER_ROUND = 10
ROUND_DELAY_SECONDS = 1
POLL_INTERVAL_SECONDS = 1
REPORT_BATCH_WINDOW_SECONDS = 0.1
MAX_REPORT_RESULTS = 2000


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
            if target.get("poolCheckId") and completed.returncode != 1:
                raise RuntimeError(f"ping command error (exit {completed.returncode})")
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
            return False, "round timeout", ""
        address_timeout = remaining / max(1, len(ordered_addresses) - index)
        try:
            check_address(target, address, address_timeout)
            return True, "", address
        except Exception as error:
            last_error = str(error) or error.__class__.__name__
    return False, last_error, ""


def check_target(target):
    started = time.monotonic()
    cancel_event = target.get("_cancel_event")
    cancelled = {"targetId": target["id"], "cancelled": True}
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
    resolved_addresses = set()
    last_error = "check failed"
    for round_index in range(1, check_rounds + 1):
        if cancel_event is not None and cancel_event.is_set():
            return cancelled
        addresses = None
        try:
            addresses = validate_target_address(target["address"], bool(target.get("allowPrivate")))
            resolved_addresses.update(addresses)
        except Exception as error:
            last_error = str(error) or error.__class__.__name__
        round_deadline = time.monotonic() + timeout
        for attempt_index in range(1, attempts_per_round + 1):
            if cancel_event is not None and cancel_event.is_set():
                return cancelled
            attempts_run += 1
            try:
                if addresses is None:
                    addresses = validate_target_address(target["address"], bool(target.get("allowPrivate")))
                    resolved_addresses.update(addresses)
                remaining = round_deadline - time.monotonic()
                attempts_left = attempts_per_round - attempt_index + 1
                if remaining <= 0:
                    raise TimeoutError("round timeout")
                attempt_result = check_attempt(target, addresses, remaining / attempts_left)
                ok, error = attempt_result[:2]
                successful_address = attempt_result[2] if len(attempt_result) > 2 else ""
                if ok:
                    return {
                        "targetId": target["id"], "ok": True,
                        "latencyMs": round((time.monotonic() - started) * 1000, 2), "error": "",
                        "rounds": check_rounds, "attemptsPerRound": attempts_per_round,
                        "roundsCompleted": round_index, "attempts": attempts_run,
                        "successfulRound": round_index, "successfulAttempt": attempt_index,
                        "resolvedAddresses": sorted(resolved_addresses),
                        "successfulAddress": successful_address,
                        "checkMarker": str(target.get("checkNowAt", ""))
                    }
                last_error = error
            except Exception as error:
                last_error = str(error) or error.__class__.__name__
        rounds_completed = round_index
        if round_index < check_rounds:
            if cancel_event is not None:
                if cancel_event.wait(ROUND_DELAY_SECONDS):
                    return cancelled
            else:
                time.sleep(ROUND_DELAY_SECONDS)
    return {
        "targetId": target["id"], "ok": False,
        "latencyMs": round((time.monotonic() - started) * 1000, 2),
        "error": f"{check_rounds} rounds x {attempts_per_round} attempts failed: {last_error}"[:200],
        "rounds": check_rounds, "attemptsPerRound": attempts_per_round,
        "roundsCompleted": rounds_completed, "attempts": attempts_run,
        "successfulRound": 0, "successfulAttempt": 0,
        "resolvedAddresses": sorted(resolved_addresses),
        "successfulAddress": "",
        "checkMarker": str(target.get("checkNowAt", ""))
    }


class CheckScheduler:
    """One bounded worker pool; report delivery never blocks slot replenishment."""

    def __init__(self, config):
        self.config = dict(config)
        self.condition = threading.Condition(threading.RLock())
        self.entries = {}
        self.running = {}
        self.pending = {}
        self.lane_cursor = 0
        self.closed = False
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1000)
        self.worker = threading.Thread(target=self._loop, name="probe-scheduler", daemon=True)
        self.reporters = [threading.Thread(target=self._report_loop, args=(pool,),
                          name="pool-reporter" if pool else "monitor-reporter", daemon=True)
                          for pool in (False, True)]
        self.worker.start()
        for reporter in self.reporters:
            reporter.start()

    @staticmethod
    def _lane(target):
        return 2 if target.get("poolCheckId") else 0 if target.get("guardId") or target.get("dynamicGuardId") else 1

    def update(self, config, targets):
        with self.condition:
            self.config = dict(config)
            incoming = {target["id"]: target for target in targets}
            for target_id, entry in list(self.entries.items()):
                if incoming.get(target_id) != entry["target"]:
                    entry["cancel"].set()
                    self.pending.pop(id(entry), None)
                    del self.entries[target_id]
            for target_id, target in incoming.items():
                if target_id not in self.entries:
                    self.entries[target_id] = {"target": dict(target), "lane": self._lane(target),
                                               "cancel": threading.Event(), "due": 0, "started": 0}
            self.condition.notify_all()

    def _current(self, entry):
        return self.entries.get(entry["target"]["id"]) is entry

    def _notify(self, _future):
        with self.condition:
            self.condition.notify_all()

    def _collect(self):
        for future, entry in list(self.running.items()):
            if not future.done():
                continue
            del self.running[future]
            if not self._current(entry):
                continue
            try:
                result = future.result()
            except Exception as error:
                # Missing evidence cannot be accepted as a failed network check.
                result = {"targetId": entry["target"]["id"], "ok": False,
                          "error": str(error)[:200], "attempts": 0}
            if result.get("cancelled"):
                entry["due"] = time.monotonic() + 5
                continue
            self.pending[id(entry)] = (entry, result)
        self.condition.notify_all()

    def _dispatch(self):
        try:
            budget = min(1000, max(1, int(self.config.get("maxConcurrency", 100))))
        except (ValueError, TypeError):
            budget = 100
        capacity = min(budget - len(self.running),
                       MAX_REPORT_RESULTS - len(self.running) - len(self.pending))
        if capacity <= 0:
            return
        now = time.monotonic()
        lanes = [[], [], []]
        for entry in self.entries.values():
            if entry["due"] <= now:
                lanes[entry["lane"]].append(entry)
        for lane in lanes:
            lane.sort(key=lambda entry: entry["due"], reverse=True)
        counts = [sum(entry["lane"] == lane for entry in self.running.values()) for lane in range(3)]
        # Pool scans cannot occupy the monitor reserve, including when a guard
        # arrives later. With the default budget of 100, scans retain 50 slots.
        limits = [budget, budget, min(100, max(1, budget // 2))]
        for _ in range(capacity):
            selected = None
            for offset in range(3):
                lane = (self.lane_cursor + offset) % 3
                if lanes[lane] and counts[lane] < limits[lane]:
                    selected = lane
                    break
            if selected is None:
                break
            self.lane_cursor = (selected + 1) % 3
            entry = lanes[selected].pop()
            entry["due"] = float("inf")
            entry["started"] = now
            future = self.executor.submit(check_target, {**entry["target"], "_cancel_event": entry["cancel"]})
            self.running[future] = entry
            counts[selected] += 1
            future.add_done_callback(self._notify)

    def _loop(self):
        with self.condition:
            while not self.closed:
                self._collect()
                self._dispatch()
                self.condition.wait(timeout=0.1)

    def _report_loop(self, pool):
        endpoint = "/probe/pool-report" if pool else "/probe/report"
        next_send = 0
        while True:
            with self.condition:
                while not self.closed:
                    batch = [(key, entry, result) for key, (entry, result) in self.pending.items()
                             if (entry["lane"] == 2) == pool]
                    if batch and time.monotonic() >= next_send:
                        # Coalesce nearby completions without waiting for slow IPs.
                        self.condition.wait_for(lambda: self.closed, timeout=REPORT_BATCH_WINDOW_SECONDS)
                        batch = [(key, entry, result) for key, (entry, result) in self.pending.items()
                                 if (entry["lane"] == 2) == pool][:MAX_REPORT_RESULTS]
                        break
                    self.condition.wait(timeout=max(0.01, min(1, next_send - time.monotonic())) if batch else None)
                if self.closed:
                    return
                config = dict(self.config)
            if not batch:
                continue
            try:
                request(config, "POST", endpoint, {"version": VERSION, "results": [row[2] for row in batch]})
            except Exception as error:
                # Retain exact evidence until acknowledged; backpressure bounds
                # both memory and work when the panel is temporarily unavailable.
                print(f"probe report failed: {error}", file=sys.stderr, flush=True)
                next_send = time.monotonic() + 1
                continue
            with self.condition:
                for key, entry, result in batch:
                    pending = self.pending.get(key)
                    if pending is None or pending[0] is not entry or pending[1] is not result:
                        continue
                    del self.pending[key]
                    if self._current(entry):
                        # Pool/guard IDs are one-shot; config removal or a new
                        # marker rearms them. Never recheck acknowledged evidence.
                        one_shot = entry["lane"] in (0, 2)
                        entry["due"] = float("inf") if one_shot else entry["started"] + max(5, int(entry["target"].get("interval", 30)))
                self.condition.notify_all()
            next_send = 0

    def close(self):
        with self.condition:
            self.closed = True
            for entry in [*self.entries.values(), *self.running.values()]:
                entry["cancel"].set()
            self.condition.notify_all()
        self.worker.join()
        self.executor.shutdown(wait=True)
        for reporter in self.reporters:
            reporter.join()


def update_config_cache(payload, targets, version):
    next_targets = targets if payload.get("unchanged") else payload.get("targets", [])
    return next_targets, str(payload.get("version", version))


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    parsed_server = urlparse(str(config.get("server", "")))
    if parsed_server.scheme != "https" and parsed_server.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("probe server must use https")
    if not config.get("secret"):
        register(config)
    scheduler = CheckScheduler(config)
    try:
        poll(config, scheduler)
    finally:
        scheduler.close()


def poll(config, scheduler):
    last_heartbeat_at = 0.0
    heartbeat_interval = 20
    config_version = ""
    targets = []
    while True:
        try:
            now = time.time()
            if now - last_heartbeat_at >= heartbeat_interval:
                request(config, "POST", "/probe/heartbeat", {"version": VERSION})
                last_heartbeat_at = now
            config_path = "/probe/config" + (f"?version={quote(config_version, safe='')}" if config_version else "")
            payload = request(config, "GET", config_path)
            targets, config_version = update_config_cache(payload, targets, config_version)
            try:
                heartbeat_interval = max(10, int(payload.get("heartbeatInterval", heartbeat_interval)))
            except (TypeError, ValueError):
                heartbeat_interval = 20
            runtime_config = {**config, "maxConcurrency": payload.get("maxConcurrency", config.get("maxConcurrency", 100))}
            scheduler.update(runtime_config, targets)
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
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
