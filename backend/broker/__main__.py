"""CLI entry point for backend.broker: `python -m backend.broker serve`, `shim`, or `local`."""
import argparse
import asyncio
import sys

from backend.broker.server import serve, serve_stdio


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Orchestration Broker CLI")
    parser.add_argument(
        "--local",
        action="store_true",
        help="Serve broker MCP tools in-process over stdio without a background broker process",
    )
    subparsers = parser.add_subparsers(dest="command", required=False)

    serve_parser = subparsers.add_parser("serve", help="Start the broker MCP server over HTTP")
    serve_parser.add_argument("--port", type=int, default=None, help="Port to listen on (default: random free port)")
    serve_parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")

    shim_parser = subparsers.add_parser("shim", help="Run the stdio MCP shim")
    shim_parser.add_argument(
        "--local",
        action="store_true",
        help="Serve broker MCP tools in-process over stdio without a background broker process",
    )

    subparsers.add_parser(
        "local",
        help="Serve broker MCP tools in-process over stdio without a background broker process",
    )

    args = parser.parse_args()

    if getattr(args, "local", False) or args.command == "local":
        serve_stdio()
    elif args.command == "serve":
        serve(port=args.port, host=args.host)
    elif args.command == "shim":
        from backend.broker.shim import main as shim_main
        asyncio.run(shim_main())
    else:
        parser.print_help(sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()

