"""CLI entry point for backend.broker: `python -m backend.broker serve` or `shim`."""
import argparse
import asyncio
import sys

from backend.broker.server import serve


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Orchestration Broker CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve_parser = subparsers.add_parser("serve", help="Start the broker MCP server over HTTP")
    serve_parser.add_argument("--port", type=int, default=None, help="Port to listen on (default: random free port)")
    serve_parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")

    shim_parser = subparsers.add_parser("shim", help="Run the stdio MCP shim")

    args = parser.parse_args()

    if args.command == "serve":
        serve(port=args.port, host=args.host)
    elif args.command == "shim":
        from backend.broker.shim import main as shim_main
        asyncio.run(shim_main())


if __name__ == "__main__":
    main()
