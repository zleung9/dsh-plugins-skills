#!/usr/bin/env python3
import json
import shutil
from pathlib import Path
import openpyxl
from refresh_index import ROOT, TARGET, FIELDS, save

ATTACHMENT = Path('/Users/zliang/.dsh/attachments/v1/files/82/82172bfeae2b44277be3417d0792ab005e76132de1dd3dd2f5296ffea8099a72/skills-readiness-2026-11-17.xlsx')
WORKSPACE = ROOT.parent
HOME = Path.home()
# Inventory limited to installed Codex skill roots, excluding marketplace checkout.
sources = []
for directory in (HOME / '.codex/skills').iterdir():
    if directory.name == '.system':
        sources.extend(p / 'SKILL.md' for p in directory.iterdir() if (p / 'SKILL.md').is_file())
    elif (directory / 'SKILL.md').is_file():
        sources.append(directory / 'SKILL.md')
for vendor in (HOME / '.codex/plugins/cache').iterdir():
    if not vendor.is_dir(): continue
    for plugin in vendor.iterdir():
        if not plugin.is_dir(): continue
        for version in plugin.iterdir():
            skills = version / 'skills'
            if skills.is_dir():
                sources.extend(p / 'SKILL.md' for p in skills.iterdir() if (p / 'SKILL.md').is_file())

links = {}
def assign(source, preferred):
    source = source.parent.resolve()
    dest = TARGET / preferred
    if dest.exists() or dest.is_symlink():
        if dest.resolve() == source: return dest / 'SKILL.md'
        preferred = 'codex-' + preferred
        dest = TARGET / preferred
    if dest.exists() or dest.is_symlink():
        if dest.resolve() == source: return dest / 'SKILL.md'
        raise RuntimeError(f'Conflicting target: {dest}')
    if str(dest) in links and links[str(dest)] != str(source):
        raise RuntimeError(f'Conflicting planned target: {dest}')
    links[str(dest)] = str(source)
    return dest / 'SKILL.md'

mapping = {}
for source in sorted(sources):
    parts = source.parts
    preferred = source.parent.name
    if 'cache' in parts:
        plugin = parts[parts.index('cache') + 2]
        preferred = plugin + '--' + preferred
    mapping[str(source)] = assign(source, preferred)

workbook = openpyxl.load_workbook(ATTACHMENT, data_only=True)
rows = []
for values in list(workbook.active.values)[1:]:
    row = dict.fromkeys(FIELDS, '')
    row.update({key: '' if val is None else str(val) for key, val in zip(FIELDS[:10], values)})
    corrected = Path(row['技能说明来源'].replace('/Users/zhuliang/', str(HOME) + '/'))
    source = corrected if corrected.is_file() else None
    alternate = False
    if source is None and '/plugins/cache/' in str(corrected):
        parts = corrected.parts
        plugin = parts[parts.index('cache') + 2]
        choices = [s for s in sources if '/plugins/cache/' in str(s) and s.parts[s.parts.index('cache') + 2] == plugin and s.parent.name.lower() == corrected.parent.name.lower()]
        if choices:
            source = sorted(choices)[-1]
            row['备注'] = '原插件版本不存在，使用本机已有版本；插件工具需由宿主提供'
    if source is not None:
        entry = mapping.get(str(source)) or assign(source, source.parent.name)
    else:
        name = row['技能名称']
        candidates = [TARGET / name / 'SKILL.md', WORKSPACE / name / 'SKILL.md'] if ':' not in name else []
        source = next((p for p in candidates if p.is_file()), None)
        if source:
            alternate = True
            entry = source if source.parent.parent == TARGET else assign(source, source.parent.name)
            row['备注'] = '原来源不存在；使用同名本地替代版本，未验证与原版一致'
        else:
            entry = None
            row['备注'] = '更正 home 后仍未找到来源；未从网络下载或创建占位技能'
    row['本机状态'] = ('本地替代版本' if alternate else '已归集') if entry else '源文件缺失'
    row['安装入口'] = str(entry) if entry else ''
    row['实际来源'] = str(source.resolve()) if source else ''
    rows.append(row)
links[str(TARGET / 'skills-index')] = str(ROOT)
refs = ROOT / 'references'
refs.mkdir(exist_ok=True)
shutil.copy2(ATTACHMENT, refs / ATTACHMENT.name)
save(rows)
manifest = {'target': str(TARGET), 'links': links, 'original_rows': len(rows), 'missing': [r['技能名称'] for r in rows if not r['安装入口']]}
(ROOT / 'migration-plan.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'new_links': len(links), 'original_rows': len(rows), 'missing_count': len(manifest['missing']), 'missing': manifest['missing']}, ensure_ascii=False, indent=2))
