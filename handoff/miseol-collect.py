#!/usr/bin/env python3
"""Runs ON Miseol's Mac (piped over ssh). Prints her own messages of the last N hours, compact, for the daily feedback report.
Sources: dotz bot 오모냥 (~/.dotz/inbox.jsonl) and OmO sessions (~/.omo/agent/sessions/*/*.jsonl, user turns only)."""
import glob, json, os, sys, time, datetime

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 24
since = time.time() - HOURS * 3600
KST = datetime.timezone(datetime.timedelta(hours=9))
home = os.path.expanduser("~")
out = []

def ts_of(v):
    try:
        return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None

def add(src, t, text):
    text = " ".join(str(text).split())
    if not text or text.startswith(("[keepalive]", "[dotz", "<", "Tool result")):
        return
    out.append((t, src, text[:400]))

# dotz inbox: only messages she typed
try:
    with open(os.path.join(home, ".dotz/inbox.jsonl"), errors="ignore") as f:
        for line in f:
            try:
                x = json.loads(line)
            except Exception:
                continue
            if x.get("kind") != "message" or "miseol" not in str(x.get("author", "")):
                continue
            t = ts_of(x.get("ts"))
            if t and t >= since:
                add("dotz:" + str(x.get("channel_name") or x.get("channel")), t, x.get("text", ""))
except FileNotFoundError:
    pass

# OmO sessions (old 오모냥 in ~/omonyang and others), user turns only; skip the dotz gateway's own sessions (covered above)
for fp in glob.glob(os.path.join(home, ".omo/agent/sessions/*/*.jsonl")):
    if os.path.getmtime(fp) < since or "-.dotz" in fp:
        continue
    proj = os.path.basename(os.path.dirname(fp)).replace("--Users-miseol-", "").strip("-") or "home"
    with open(fp, errors="ignore") as f:
        for line in f:
            if '"user"' not in line:
                continue
            try:
                x = json.loads(line)
            except Exception:
                continue
            m = x.get("message") or {}
            if m.get("role") != "user":
                continue
            t = ts_of(x.get("timestamp") or x.get("ts"))
            if not t or t < since:
                continue
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
            add("omo:" + proj, t, c or "")

out.sort()
seen = set()
for t, src, text in out:
    k = (src, text[:120])
    if k in seen:
        continue
    seen.add(k)
    print(f"{datetime.datetime.fromtimestamp(t, KST):%m-%d %H:%M} [{src}] {text}")
print(f"# {len(seen)} messages, last {HOURS:g}h", file=sys.stderr)
