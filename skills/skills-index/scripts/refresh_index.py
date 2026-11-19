#!/usr/bin/env python3
"""Refresh file availability, preserving original readiness evidence."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = Path.home() / '.agents/skills'
FIELDS = ['类别', '技能名称', '功能', '检查结论', '现在能做什么', '缺少或按需依赖', '密钥/账号/连接', '检查证据', '下一步', '技能说明来源', '本机状态', '安装入口', '实际来源', '备注']

def metadata(path):
    text = path.read_text(encoding='utf-8')
    match = re.search(r'^description:\s*(.+)$', text, re.M)
    return match.group(1).strip('"\'') if match else '详见技能说明'

def save(rows):
    refs = ROOT / 'references'
    refs.mkdir(exist_ok=True)
    with (refs / 'skills-index.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    lines = ['# 本机技能索引', '', f'共 {len(rows)} 条记录。文件存在不代表依赖、账号或插件工具可用；原表检查结论保留作历史参考。', '', 'CSV： [skills-index.csv](skills-index.csv)', '', '| 类别 | 技能 | 本机状态 | 入口 |', '|---|---|---|---|']
    for r in rows:
        name = r['技能名称'].replace('|', '\\|')
        path = r['安装入口']
        link = f'[SKILL.md](<{path}>)' if path and Path(path).is_file() else '—'
        lines.append(f"| {r['类别']} | {name} | {r['本机状态']} | {link} |")
    (refs / 'INDEX.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

def refresh():
    with (ROOT / 'references/skills-index.csv').open(encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    covered = set()
    for r in rows:
        entry = r['安装入口']
        if not entry:
            candidates = [TARGET / r['技能名称'] / 'SKILL.md', TARGET / Path(r['技能说明来源']).parent.name / 'SKILL.md']
            found = next((p for p in candidates if p.is_file()), None)
            if found:
                entry = str(found)
                r['安装入口'] = entry
                r['备注'] = '刷新发现本地替代版本；未验证与原来源一致'
        if entry:
            p = Path(entry)
            r['本机状态'] = ('本地替代版本' if '替代' in r['备注'] else '已归集') if p.is_file() else '入口缺失'
            covered.add(str(p))
            if p.is_file(): r['实际来源'] = str(p.resolve())
        else:
            r['本机状态'] = '源文件缺失'
    for directory in sorted(TARGET.iterdir()):
        p = directory / 'SKILL.md'
        if not p.is_file() or str(p) in covered:
            continue
        row = dict.fromkeys(FIELDS, '')
        row.update({'类别': '本机补充技能', '技能名称': directory.name, '功能': metadata(p), '检查结论': '未检查运行依赖', '技能说明来源': str(p.resolve()), '本机状态': '已归集', '安装入口': str(p), '实际来源': str(p.resolve()), '备注': '扫描目标目录补入'})
        rows.append(row)
    save(rows)
    print(f'索引共 {len(rows)} 条；有入口 {sum(bool(r["安装入口"]) and Path(r["安装入口"]).is_file() for r in rows)} 条；源文件缺失 {sum(r["本机状态"] == "源文件缺失" for r in rows)} 条。')

if __name__ == '__main__':
    refresh()
