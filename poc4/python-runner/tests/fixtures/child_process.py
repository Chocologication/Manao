"""Test fixture: a derived Python process that ignores SIGTERM (python runtime plan, task 4).

The TERM scenario runs it as the child of a console main.py inside the real launcher
chain: parent and child append start markers to the evidence file named by
MANAO_TEST_EVIDENCE and then sleep forever. SIGTERM is deliberately ignored, so only the
death of the namespace's PID 1 (or a forced kill) can end this process — the test uses
that to prove a derived Python process is reaped together with the container instead of
surviving a stop.
"""
import os
import signal
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)

with open(os.environ["MANAO_TEST_EVIDENCE"], "a", encoding="utf-8") as handle:
    handle.write("child-started\n")
    handle.flush()

while True:
    time.sleep(3600)
