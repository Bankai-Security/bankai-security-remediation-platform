"""Inert command construction fixture; the command is never run on import."""

import subprocess


def lookup_host(hostname: str) -> str:
    # Fixture: caller-controlled text is interpolated into a shell command.
    command = f"nslookup {hostname}"
    return subprocess.check_output(command, shell=True, text=True)
