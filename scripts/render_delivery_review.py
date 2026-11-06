"""Build an offline index of frozen trials, pilots and separately labelled continuations."""
import argparse
import html
import json
from pathlib import Path

from scripts.render_review import render


def escaped(value):
    return html.escape(str(value), quote=True)


def build(root):
    sections = []
    for cohort in sorted(root.glob('202*-v02-e*')):
        page = render(cohort)
        (cohort / 'review.html').write_text(page, encoding='utf-8')
        sections.append(f'<li><a href="{escaped(cohort.name)}/review.html">{escaped(cohort.name)}</a> '
                        + ('正式九次冻结实验' if cohort.name.endswith('-e3') else '开发 pilot，不并入正式成功数') + '</li>')
    histories = []
    for folder, label in ((Path('runs'), 'v0.1历史原始运行；型号以该次配置为准'),
                          (Path('runs/v02-development'), '开发期生成及续跑'),
                          (Path('runs/v02-extra-repair'), '正式实验后的追加修复，不改写九次结果'),
                          (Path('runs/v02-clean-windows'), '干净Windows最终exe验收；生成项目未在此运行'),
                          (Path('.local/验收 空格/gui-e3-runs'), '宿主最终 exe 真实生成与取消')):
        for run in sorted(folder.glob('run-*')):
            report_file = run / 'artifacts/report.json'
            report = json.loads(report_file.read_text(encoding='utf-8')) if report_file.exists() else {}
            body = [f'<p>{escaped(run.as_posix())}</p>',
                    f'<pre>{escaped(json.dumps({k: report.get(k) for k in ("status", "generation_origin", "seed_project", "turns", "repair_rounds", "elapsed_seconds", "run_estimated_cny", "error")}, ensure_ascii=False, indent=2))}</pre>']
            for check in report.get('checks', []):
                body.append(f'<details><summary>{escaped(check.get("profile"))} · {escaped(check.get("status"))}</summary>'
                            f'<pre>{escaped(json.dumps(check, ensure_ascii=False, indent=2))}</pre></details>')
            histories.append(f'<details><summary>{escaped(label)} · {escaped(run.name)} · {escaped(report.get("status", "未形成最终报告"))}</summary>{"".join(body)}</details>')
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>v0.2 交付证据索引</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;background:#f3f5f8;color:#203047;font:16px/1.7 system-ui}details{background:white;border:1px solid #ccd6df;border-radius:8px;padding:18px;margin:16px 0}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:600px;overflow:auto;font-size:13px}a{color:#146e73}</style>'
            '<h1>v0.2 交付证据索引</h1><p>正式实验、开发失败、中断及追加修复分别列示。有效响应费用不等于服务商账单；跳过和未验证不计通过。所有日志按文本转义，无脚本。</p>'
            '<p>下载证据包解压后可离线展开原始检查。源码、输入、工具交换与版本快照保存在原始 runs 目录；本页不修改任何运行报告。</p><ul>'
            + ''.join(sections) + '</ul><h2>其他运行与谱系</h2>' + ''.join(histories) + '</html>')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('experiments/v02/review.html'))
    args = parser.parse_args()
    args.output.write_text(build(Path('experiments/v02')), encoding='utf-8')
    print(args.output)
