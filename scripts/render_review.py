"""Render an offline evidence review page. All model/runtime text is HTML-escaped."""
import argparse
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.summarize_benchmark import summarize


def escape(value):
    return html.escape(str(value), quote=True)


def render(folder):
    data = summarize(folder)
    rows, details = [], []
    for trial in data['trials']:
        count = trial.get('project_test_counts', {}).get('test', {})
        tests = '/'.join(str(count.get(k, '?')) for k in ('pass', 'fail', 'skipped')) if 'pass' in count else '未统计'
        runtime = trial.get('runtime_check_counts', {})
        integrity = ('未形成最终清单' if not trial.get('final_manifest_available') else
                     '失败' if trial.get('integrity_errors') else '已记录文件及额外文件核验通过')
        success = trial.get('automatic_acceptance_success', False)
        rows.append('<tr>' + ''.join(f'<td>{escape(v)}</td>' for v in (
            trial['trial'], trial['case'], trial['repeat'], trial['repair_rounds'], trial['status'], tests,
            runtime.get('passed', 0), trial.get('turns', '—'), trial.get('valid_usage_estimate_cny', '—'))) + '</tr>')
        body = [f'<p class="path">{escape(trial.get("run", "尚未分配最终运行路径"))}</p>',
                f'<p>文件核验：{escape(integrity)}；自动验收：{"通过，仍须设计审查" if success else "未达到完整自动验收条件"}。</p>']
        if trial.get('run'):
            report_path = Path(trial['run']) / 'artifacts/report.json'
            if report_path.exists():
                report = json.loads(report_path.read_text(encoding='utf-8'))
                body.append(f'<p>生成来源：{escape(report.get("generation_origin", "未知"))}；实际修复轮数：{escape(report.get("repair_rounds", "未知"))}。</p>')
                for check in report.get('checks', []):
                    body.append(f'<details><summary>{escape(check.get("profile"))} · {escape(check.get("status"))}</summary>'
                                f'<pre>{escape(json.dumps(check, ensure_ascii=False, indent=2))}</pre></details>')
                if report.get('error'):
                    body.append(f'<pre>{escape(report["error"])}</pre>')
        details.append(f'<details class="trial"><summary>试验 {escape(trial["trial"])} · {escape(trial["case"])} · {escape(trial["status"])}</summary>{"".join(body)}</details>')
    header = ''.join(f'<th>{escape(name)}</th>' for name in ('试验', '案例', '重复', '修复上限', '原始结果', '自带测试 过/失/跳', 'HTTP通过项', '模型轮次', '用量估算¥'))
    group_header = ''.join(f'<th>{escape(name)}</th>' for name in ('案例', '修复上限', '记录/计划', '自动验收通过', '全部原始结果', '用量估算¥'))
    group_rows = []
    for group in data['groups']:
        outcomes = '；'.join(f'{name} × {number}' for name, number in group['outcomes'].items()) or '尚未开始'
        group_rows.append('<tr>' + ''.join(f'<td>{escape(value)}</td>' for value in (
            group['case'], group['repair_rounds'], f'{group["recorded"]}/{group["planned"]}',
            group['automatic_acceptance_successes'], outcomes, group['valid_usage_estimate_cny'])) + '</tr>')
    return f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(data['cohort'])} · 实验证据审阅</title><link rel="icon" href="data:,">
<style>body{{margin:0;background:#f3f5f8;color:#203047;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}}main{{max-width:1220px;margin:auto;padding:36px 24px}}h1{{margin:0;font-size:32px}}.eyebrow{{color:#146e73;font-weight:700}}.note{{background:#fff7e5;border-left:4px solid #b07a13;padding:18px 22px;margin:24px 0}}.card,.trial{{background:white;border:1px solid #dce3ec;border-radius:10px;padding:20px;margin:18px 0}}table{{width:100%;min-width:1100px;border-collapse:collapse;font-size:14px}}td,th{{text-align:left;padding:12px 9px;border-bottom:1px solid #e5eaf0}}th{{background:#edf3f7;white-space:nowrap}}td:nth-child(5){{max-width:260px;overflow-wrap:anywhere;font-family:monospace}}.scroll{{overflow:auto}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f9;padding:16px;font:13px/1.6 monospace;max-height:600px;overflow:auto}}summary{{cursor:pointer;font-weight:650}}details details{{margin:12px 0}}.path{{font-family:monospace;overflow-wrap:anywhere}}footer{{color:#52677c;font-size:14px}}</style>
<main><div class="eyebrow">DESIGNCODEAGENT · 可复核实验</div><h1>从设计到仓库：生成与反馈修复</h1>
<p>{escape(data['cohort'])} · {escape(data['model'])} · 固定设置、全部结果、原始证据</p>
<div class="note">小样本可行性观察。未开始、失败、中断、跳过均保留；不推导普遍成功率、统计显著性、生产可用或多 Agent 优势。用量费用不含无法确认的请求预留，后者保留在全局账本。自动验收通过仍需审查设计语义和浏览器行为。</div>
<section class="card"><h2>逐次结果</h2><div class="scroll"><table><thead><tr>{header}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p>HTTP列仅表示实际通过项数，不能据此忽略失败或未运行；展开原始 runtime 结果查看完整状态。</p></section>
<section class="card"><h2>固定分组</h2><div class="scroll"><table><thead><tr>{group_header}</tr></thead><tbody>{''.join(group_rows)}</tbody></table></div></section>
<h2>展开原始检查</h2>{''.join(details)}<footer>离线静态审阅页，无脚本。原始输入、工具事件和源码快照位于同一证据包的 runs 目录；本页没有改写原始报告。</footer></main></html>'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.write_text(render(args.cohort), encoding='utf-8')
    print(args.output)
