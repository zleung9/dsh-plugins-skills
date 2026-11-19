#!/usr/bin/env python3
"""Inspect DSH model-routing configuration and diagnose missing capability declarations.

Why this exists: DSH's image tool refuses to read an image unless the resolved
model route *explicitly declares* `input: [text, image]`. The declaration is NOT
inferred from what the model can actually do, and the endpoint's `/v1/models`
reply carries no capability metadata. So a model that genuinely reads images
will still be refused until its config entry says so. This script finds those
gaps and, critically, shows which profile each provider route belongs to.

Usage:
    dsh_capability.py [--home ~/.dsh] [--profile NAME] [--json]

Exit codes:
    0  no undeclared-but-plausible-capable models found
    1  at least one route has models missing an image declaration
    2  could not inspect (dsh binary missing, config unparsable)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - fallback path is exercised by design
    yaml = None

# The two modalities DSH's pi-ai adapter accepts on a model entry.
KNOWN_MODALITIES = ("text", "image")

# A model id is worth investigating for image support when it looks like a
# vision-capable family. Kept deliberately broad: false positives here are
# cheap (the operator confirms with a real image), false negatives are
# expensive (a vision model stays silently text-only).
VISION_HINTS = (
    "v4.1", "v4p1", "flash", "vision", "vl", "omni", "gpt-4", "gpt-5",
    "gpt-6", "claude", "gemini", "glm-4", "glm-5", "qwen-vl", "qwen2-vl",
    "qwen3-vl",
)


def find_dsh() -> str | None:
    return shutil.which("dsh")


def dsh_home(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser()
    env = os.environ.get("DSH_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".dsh"


def run_dump(profile: str, home: Path) -> str:
    """Return `dsh --profile X --dump-config` stdout, or '' when unavailable."""
    dsh = find_dsh()
    if dsh is None:
        return ""
    env = dict(os.environ, DSH_HOME=str(home))
    try:
        proc = subprocess.run(
            [dsh, "--profile", profile, "--dump-config"],
            capture_output=True, text=True, timeout=120, env=env,
        )
    except (subprocess.TimeoutExpired, OSError):
        return ""
    return proc.stdout


def profile_names(home: Path) -> list[str]:
    d = home / "profiles"
    if not d.is_dir():
        return []
    return sorted(p.name for p in d.iterdir() if (p / "package.json").is_file())


def _split_entry_block(text: str, entry_id: str) -> str | None:
    """Return the YAML text of one top-level `- id: <entry_id>` block."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"^- id: {re.escape(entry_id)}\s*$", line):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(r"^- id: ", lines[i]):
            end = i
            break
    return "\n".join(lines[start:end])


def _load_yaml(text: str):
    """Parse YAML, tolerating the `!!js` tags the dump embeds.

    The dump prints `!!js` expressions verbatim, which strict loaders reject.
    Registering a no-op constructor for that tag lets a real YAML parser do the
    work instead of hand-rolled indentation heuristics. Hand-parsing was tried
    first and silently misread block-style `input:` lists, reporting
    `['text']` for a model that actually declared `['text','image']` — a false
    negative that would have pointed the operator at a non-problem.
    """
    if yaml is None:
        return None
    class _Loader(yaml.SafeLoader):
        pass
    _Loader.add_constructor("tag:yaml.org,2002:js", lambda loader, node: "<js>")
    try:
        return yaml.load(text, Loader=_Loader)
    except Exception:
        return None


def parse_llm_block(dump: str) -> dict | None:
    """Extract the composed `llm-pi-ai` entry's config from a config dump.

    Prefers a real YAML parse. Falls back to a structural scan only when no
    YAML library is importable, and in that case the caller is told the result
    may be incomplete so it is never presented as authoritative.
    """
    block = _split_entry_block(dump, "llm-pi-ai")
    if block is None:
        return None

    parsed = _load_yaml(block)
    if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
        entry = parsed[0]
        providers = ((entry.get("config") or {}).get("providers")) or {}
        out = {}
        for name, info in providers.items():
            if not isinstance(info, dict):
                continue
            models = []
            for m in info.get("models") or []:
                if isinstance(m, dict) and m.get("id"):
                    models.append({"id": m["id"], "input": m.get("input")})
            out[name] = {"models": models, "fields": {
                k: v for k, v in info.items() if k != "models" and isinstance(v, (str, int, float))
            }}
        return {"providers": out, "reliable": True}

    # No YAML library: structural fallback, flagged as lower confidence.
    return _parse_llm_block_structural(block)


def _parse_llm_block_structural(block: str) -> dict:
    """Indentation-based fallback used only when no YAML parser is available."""
    providers: dict[str, dict] = {}
    current_route = None
    in_models = False
    current_model = None

    for raw in block:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        stripped = raw.strip()

        # Route keys sit two levels under `config: providers:` (indent 6).
        m = re.match(r"^([A-Za-z0-9_.\-]+):\s*$", stripped)
        if m and indent == 6:
            current_route = m.group(1)
            providers[current_route] = {"models": [], "fields": {}}
            in_models = False
            current_model = None
            continue

        if current_route is None:
            continue

        if stripped.startswith("models:"):
            in_models = True
            continue

        # Route-level scalar fields (displayName, api, baseURL, apiKeyEnv...).
        if indent == 8 and not in_models:
            fm = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", stripped)
            if fm:
                providers[current_route]["fields"][fm.group(1)] = fm.group(2).strip()
            continue

        # `- id: <model>` starts a model entry; `input:` may follow on the
        # same line or as its own line, then as a `- text` / `- image` list.
        mm = re.match(r"^-\s+id:\s*(\S+)\s*$", stripped)
        if mm and in_models:
            current_model = {"id": mm.group(1), "input": None}
            providers[current_route]["models"].append(current_model)
            continue

        if current_model is not None:
            if stripped.startswith("input:"):
                inline = stripped.split(":", 1)[1].strip()
                if inline.startswith("[") and inline.endswith("]"):
                    items = [x.strip().strip("'\"") for x in inline[1:-1].split(",")]
                    current_model["input"] = [x for x in items if x]
                else:
                    current_model["input"] = []  # block list follows
                continue
            if stripped.startswith("- ") and current_model["input"] == []:
                current_model["input"].append(stripped[2:].strip().strip("'\""))
                continue
            # A new route key ends this model's field run. (`- id:` is handled
            # above, before this block, so a following model entry never
            # truncates an in-progress input list.)
            if re.match(r"^[A-Za-z0-9_.\-]+:\s*$", stripped):
                in_models = in_models

    return {"providers": providers}


def looks_vision_capable(model_id: str) -> bool:
    low = model_id.lower()
    return any(h in low for h in VISION_HINTS) or low.startswith("gpt-")


def declared_routes_from_profile_file(home: Path, profile: str) -> dict[str, str]:
    """Route key -> baseURL as written in the profile's OWN cordis.patch.yml.

    The composed dump cannot answer this: a machine-wide patch replaces the
    entry's whole config, so every profile reports the patch author's routes
    and the profile's own routes become invisible. Reading the profile file
    directly is the only way to see that they disagree.
    """
    path = home / "profiles" / profile / "cordis.patch.yml"
    if not path.is_file():
        return {}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^- id: llm-pi-ai\s*$", line):
            start = i
            break
    if start is None:
        return {}
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(r"^- id: ", lines[i]):
            end = i
            break
    routes: dict[str, str] = {}
    in_providers = False
    current = None
    for raw in lines[start:end]:
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip())
        if stripped == "providers:":
            in_providers = True
            continue
        if not in_providers or not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_.\-]+):\s*(.*)$", stripped)
        if m and indent == 6:
            current = m.group(1)
            routes[current] = ""
            continue
        if current and indent == 8 and stripped.startswith("baseURL:"):
            routes[current] = stripped.split(":", 1)[1].strip()
    return routes


def analyse(home: Path, profiles: list[str]) -> dict:
    per_profile: dict[str, dict] = {}
    # (provider_route, baseURL) -> profiles declaring it. Identical route keys
    # with different baseURLs across profiles is the cross-profile collision
    # signal: a machine-wide patch for one would redirect/erase the other.
    route_index: dict[tuple[str, str], list[str]] = {}
    # Route key -> {baseURL: [profiles as declared in their own files]}.
    own_route_index: dict[str, dict[str, list[str]]] = {}

    for prof in profiles:
        for route, base in declared_routes_from_profile_file(home, prof).items():
            own_route_index.setdefault(route, {}).setdefault(base, []).append(prof)

    for prof in profiles:
        dump = run_dump(prof, home)
        if not dump:
            per_profile[prof] = {"error": "dump-config unavailable"}
            continue
        parsed = parse_llm_block(dump)
        if parsed is None:
            per_profile[prof] = {"routes": {}, "note": "no llm-pi-ai entry"}
            continue
        routes = {}
        for name, info in parsed["providers"].items():
            base = info["fields"].get("baseURL", "")
            route_index.setdefault((name, base), []).append(prof)
            routes[name] = {
                "baseURL": base,
                "api": info["fields"].get("api", ""),
                "apiKeyEnv": info["fields"].get("apiKeyEnv", ""),
                "models": info["models"],
            }
        per_profile[prof] = {"routes": routes}

    findings = []
    for prof, data in per_profile.items():
        for route, info in (data.get("routes") or {}).items():
            for model in info["models"]:
                declared = model["input"]
                has_image = bool(declared) and "image" in declared
                if has_image:
                    continue
                if looks_vision_capable(model["id"]):
                    findings.append({
                        "profile": prof,
                        "route": route,
                        "baseURL": info["baseURL"],
                        "model": model["id"],
                        "declared_input": declared,
                        "reason": "declares no image input; verify with a real image before declaring",
                    })

    # A collision is one route key carrying DIFFERENT baseURLs across profiles
    # as each profile declares it. Same baseURL everywhere is benign sharing.
    collisions = [
        {"route": route, "by_baseURL": by_base}
        for route, by_base in own_route_index.items()
        if len(by_base) > 1
    ]

    # Also flag when a route a profile declares does NOT appear in its composed
    # config: that means a higher layer (usually the home patch) overwrote it.
    masked = []
    for prof, data in per_profile.items():
        own = declared_routes_from_profile_file(home, prof)
        composed = set((data.get("routes") or {}).keys())
        for route in own:
            if route not in composed:
                masked.append({"profile": prof, "declared_route": route,
                               "composed_routes": sorted(composed)})

    return {
        "dsh_home": str(home),
        "profiles": per_profile,
        "findings": findings,
        "route_collisions": collisions,
        "masked_routes": masked,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--home", help="DSH home (default: $DSH_HOME or ~/.dsh)")
    ap.add_argument("--profile", help="inspect only this profile")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args()

    home = dsh_home(args.home)
    if not home.is_dir():
        print(f"DSH home not found: {home}", file=sys.stderr)
        return 2
    if find_dsh() is None:
        print("dsh binary not found on PATH", file=sys.stderr)
        return 2

    profiles = [args.profile] if args.profile else profile_names(home)
    if not profiles:
        print(f"no profiles under {home / 'profiles'}", file=sys.stderr)
        return 2

    result = analyse(home, profiles)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 1 if result["findings"] else 0

    print(f"DSH home: {home}")
    print(f"profiles inspected: {', '.join(profiles)}")
    print()

    print("== provider routes per profile ==")
    for prof, data in result["profiles"].items():
        if data.get("error"):
            print(f"  {prof}: {data['error']}")
            continue
        routes = data.get("routes") or {}
        if not routes:
            print(f"  {prof}: (no llm-pi-ai config)")
            continue
        for route, info in routes.items():
            n_image = sum(1 for m in info["models"]
                          if m["input"] and "image" in m["input"])
            print(f"  {prof:10} {route:18} {len(info['models']):2} models, "
                  f"{n_image} declared image   {info['baseURL']}")
    print()

    if result["route_collisions"]:
        print("== WARNING: one route key, different baseURL per profile ==")
        for c in result["route_collisions"]:
            print(f"  route '{c['route']}':")
            for base, profs in c["by_baseURL"].items():
                print(f"     {base or '(no baseURL)':40} <- {', '.join(profs)}")
        print("  A machine-wide patch ($DSH_HOME/cordis.patch.yml) replaces this")
        print("  entry's whole config in EVERY profile, so all but one profile's")
        print("  version is silently discarded. Prefer per-profile patches.")
        print()

    if result["masked_routes"]:
        print("== WARNING: routes a profile declares but its composed config lacks ==")
        for m in result["masked_routes"]:
            print(f"  {m['profile']}: declared '{m['declared_route']}' but composed has "
                  f"{m['composed_routes']}")
        print("  Something at a higher layer overwrote this entry. Check")
        print(f"  {home / 'cordis.patch.yml'} (applies to every profile).")
        print()

    print("== models missing an explicit image declaration ==")
    if not result["findings"]:
        print("  none — every vision-plausible model either declares image or is absent")
    for f in result["findings"]:
        print(f"  {f['profile']:10} {f['model']:24} route={f['route']:16} "
              f"declared={f['declared_input']}")
        print(f"    -> {f['reason']}")
    print()

    print("Next: confirm each candidate with a REAL image before declaring it.")
    print("See references/verify-image-support.md for the end-to-end check.")
    return 1 if result["findings"] else 0


if __name__ == "__main__":
    sys.exit(main())
