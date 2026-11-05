import argparse
import json
import signal
import sys
import threading
from pathlib import Path

from .budget import Budget, Prices, default_ledger
from .config import user_variable
from .engine import Agent
from .inputs import load_inputs
from .provider import API_ROOT, DeepSeek


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser(description="DesignCodeAgent：架构文档到代码仓库")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("gui", help="打开桌面界面")
    inspect = sub.add_parser("inspect", help="仅解析输入；不调用 API")
    inspect.add_argument("architecture", type=Path)
    inspect.add_argument("views", type=Path)
    for name in ("run", "connection"):
        command = sub.add_parser(name)
        command.add_argument("--provider", choices=("deepseek", "bailian"), default="deepseek")
        command.add_argument("--base-url", default=API_ROOT)
        command.add_argument("--model", default=None)
        command.add_argument("--confirm-pricing", action="store_true", help="已核对当前价格不超过给定计价上界")
        command.add_argument("--input-price", type=float, default=None, help="输入元/百万 tokens；百炼必须填写")
        command.add_argument("--output-price", type=float, default=None, help="输出元/百万 tokens；百炼必须填写")
        command.add_argument("--budget", type=float, default=50)
        if name == "run":
            command.add_argument("architecture", type=Path)
            command.add_argument("views", type=Path)
            command.add_argument("--output", type=Path, default=Path("runs"))
            command.add_argument("--allow-project-execution", action="store_true", help="允许以当前用户权限执行生成项目的 npm 脚本（非沙箱）")
            command.add_argument("--seed-project", type=Path, help="复制已有生成项目并从未完成任务续跑；不修改原始运行")
    args = parser.parse_args()
    if args.command == "gui":
        from .gui import main as gui
        gui()
        return
    if args.command == "inspect":
        print(json.dumps(load_inputs(args.architecture, args.views), indent=2, ensure_ascii=False))
        return
    cancel = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: cancel.set())
    try:
        if args.provider == "bailian" and (args.input_price is None or args.output_price is None):
            raise ValueError("百炼模式必须显式指定 --input-price 和 --output-price（元/百万 tokens）")
        prices = Prices(args.input_price if args.input_price is not None else 10.56,
                        args.output_price if args.output_price is not None else 31.68)
        budget = Budget(default_ledger(), args.budget, prices)
        key = user_variable("DASHSCOPE_API_KEY" if args.provider == "bailian" else "DEEPSEEK_API_KEY")
        provider = DeepSeek(key, budget, cancel, pricing_confirmed=args.confirm_pricing,
                            provider=args.provider, base_url=args.base_url,
                            model=args.model or (user_variable("DASHSCOPE_MODEL") or "deepseek-v4-pro-0813" if args.provider == "bailian" else "deepseek-v4-pro"))
        if args.command == "connection":
            print(json.dumps(provider.test_connection(), ensure_ascii=False, indent=2))
            return

        def emit(event):
            if event["event"] == "tool_result":
                print(f"[{event['phase']}] {event['tool']}: {json.dumps(event['result'], ensure_ascii=False)[:220]}", flush=True)
            elif event["event"] != "assistant":
                print(json.dumps(event, ensure_ascii=False), flush=True)

        agent = Agent(provider, cancel, emit, allow_execution=args.allow_project_execution)
        run_dir, report = agent.run(args.architecture, args.views, args.output, seed_project=args.seed_project)
        print(json.dumps({"run_dir": str(run_dir), "status": report["status"]}, ensure_ascii=False))
        if report["status"] in ("failed", "failed_validation", "cancelled"):
            raise SystemExit(1)
    except (ValueError, RuntimeError, OSError) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
