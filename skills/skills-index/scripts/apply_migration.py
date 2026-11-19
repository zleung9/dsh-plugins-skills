#!/usr/bin/env python3
"""Apply reviewed additive symlink plan; never replace existing entries."""
import json
from pathlib import Path
from refresh_index import ROOT, TARGET, refresh

plan = json.loads((ROOT / 'migration-plan.json').read_text())
assert Path(plan['target']) == TARGET
for destination, source in plan['links'].items():
    dst, src = Path(destination), Path(source)
    assert dst.parent == TARGET and (src / 'SKILL.md').is_file(), (dst, src)
    if dst.exists() or dst.is_symlink():
        assert dst.resolve() == src.resolve(), f'Existing entry differs: {dst}'
for destination, source in plan['links'].items():
    dst = Path(destination)
    if not dst.is_symlink() and not dst.exists():
        dst.symlink_to(source, target_is_directory=True)
    assert (dst / 'SKILL.md').is_file(), dst
refresh()
print(f'已验证 {len(plan["links"])} 个技能入口；保留全部来源及原有入口。')
