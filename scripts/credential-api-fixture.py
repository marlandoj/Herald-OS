"""Synthetic-only HTTP handler transport for the trusted IPC integration test.

No server lifespan, provider calls, runtime edits or real profile reads.
Only machine-readable fixture responses reach the Node main-process test.
"""
import json
import os
from pathlib import Path
import socket
import sys

PROJECT = Path(__file__).resolve().parents[1]
CACHE = PROJECT / 'node_modules/.cache/credential-ipc-integration'
HOME = Path(os.environ['HERMES_HOME']).resolve()
SOURCE = Path(os.environ['TEST_HERMES_SOURCE']).resolve()
if not HOME.is_relative_to(CACHE.resolve()) or not (SOURCE / 'hermes_cli/config.py').is_file():
    raise SystemExit('Fixture isolation required')
os.environ.clear()
os.environ.update({'HOME': str(HOME), 'HERMES_HOME': str(HOME), 'PATH': '/usr/bin:/bin',
                   'XDG_CONFIG_HOME': str(HOME / 'xdg-config'), 'XDG_DATA_HOME': str(HOME / 'xdg-data'),
                   'DO_NOT_TRACK': '1', 'HERMES_TELEMETRY_ENABLED': 'false'})
sys.dont_write_bytecode = True
sys.path.insert(0, str(SOURCE))
original_connect = socket.socket.connect


def no_network(sock, target):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        raise RuntimeError('Network prohibited in fixture')
    return original_connect(sock, target)


socket.socket.connect = no_network
from fastapi.testclient import TestClient
from hermes_cli.web_server import app, _SESSION_TOKEN

request = json.load(sys.stdin)
# No context-manager: never run the server/gateway lifespan.
response = TestClient(app).request(request['method'], request['path'],
    json=request.get('body'), params=request.get('query'),
    headers={'X-Hermes-Session-Token': _SESSION_TOKEN})
print(json.dumps({'status': response.status_code, 'body': response.json()}))
