#!/usr/bin/env python3
"""Reads alice.lifeline-team.testnet's real rescues from the testnet vault (get_rescues) into film/public/data/rescues.json."""
import json, os, urllib.request, base64
HERE = os.path.dirname(os.path.abspath(__file__))
def view(m, a):
    body = {"jsonrpc": "2.0", "id": "x", "method": "query", "params": {"request_type": "call_function", "finality": "final",
            "account_id": "vault.lifeline-team.testnet", "method_name": m, "args_base64": base64.b64encode(json.dumps(a).encode()).decode()}}
    req = urllib.request.Request("https://test.rpc.fastnear.com", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.loads(bytes(json.load(urllib.request.urlopen(req, timeout=30))["result"]["result"]).decode())
user = "alice.lifeline-team.testnet"
n = view("get_rescue_count", {"user": user})
rows = view("get_rescues", {"user": user, "from": 0, "limit": n})
out = {"user": user, "vault": "vault.lifeline-team.testnet", "count": n, "rescues": rows}
os.makedirs(os.path.join(HERE, "film/public/data"), exist_ok=True)
json.dump(out, open(os.path.join(HERE, "film/public/data/rescues.json"), "w"), indent=1)
print(n, "rescues; first", rows[0]["at"], "last", rows[-1]["at"])
