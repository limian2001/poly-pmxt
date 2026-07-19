import signal
import sys
from datetime import datetime

import pmxt


def fmt(address: str) -> str:
    if len(address) > 10:
        return f"{address[:6]}...{address[-4:]}"
    return address


def run():
    exchange = pmxt.Polymarket()

    # -- Step 1: Define and find whales ----------------------------------------
    # For simplicity, here I assume the trader with the largest volume is a "whale"
    print("Fetching top volume traders in all time...\n")
    whales = exchange.call_api("getV1Leaderboard", {
        "category": "OVERALL",
        "timePeriod": "ALL",
        "orderBy": "VOL",
        "limit": 10,
    })

    print("Rank  Name                           Address        Volume (USDC)   PnL (USDC)")
    print("-" * 82)
    for w in whales:
        rank = str(w.get("rank", "")).rjust(2)
        name = fmt(w.get("userName", "")).ljust(30)
        addr = fmt(w.get("proxyWallet", "")).ljust(14)
        vol  = f"${w.get('vol', 0) / 1_000_000:.1f}M".rjust(14)
        pnl  = f"${w.get('pnl', 0) / 1_000:.1f}K".rjust(12)
        print(f"  {rank}  {name} {addr} {vol} {pnl}")

    # -- Step 2: Watch the top whale -------------------------------------------
    whale = whales[0]
    label = whale.get("userName")
    address = whale.get("proxyWallet")
    print(f"\nWatching {label} ({address}) ...")
    print("Press Ctrl+C to stop.\n")

    running = True

    def handle_sigint(sig, frame):
        nonlocal running
        print("\nStopping...")
        running = False
        try:
            exchange.unwatch_address(address)
        except Exception:
            pass
        finally:
            sys.exit(0)

    signal.signal(signal.SIGINT, handle_sigint)

    try:
        while running:
            snapshot = exchange.watch_address(address, ["trades", "positions"])
            print(f"\n[Update @ {datetime.now().strftime('%H:%M:%S')}]")
            if snapshot.trades:
                for t in snapshot.trades:
                    print(f"  Trade: {t.side.upper()} {t.amount:.0f} shares @ ${t.price:.3f}")
            if snapshot.positions:
                for p in snapshot.positions:
                    print(f"  Position: {p.outcome_label} size={p.size:.2f} entry=${p.entry_price:.3f}")
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    run()
