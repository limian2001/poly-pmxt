#!/usr/bin/env python3
"""Test WebSocket feed streaming from api.pmxt.dev."""

import asyncio
import json
import os
import websockets


async def main():
    api_key = os.environ.get("PMXT_API_KEY", "")
    if not api_key:
        print("Set PMXT_API_KEY environment variable")
        return

    url = f"wss://api.pmxt.dev/ws?apiKey={api_key}"

    async with websockets.connect(url) as ws:
        print("Connected to wss://api.pmxt.dev/ws")

        await ws.send(json.dumps({
            "id": "btc-stream",
            "action": "subscribe",
            "method": "watchTicker",
            "args": ["BTC/USDT"],
            "feed": "binance",
        }))

        count = 0
        async for raw in ws:
            msg = json.loads(raw)

            if msg.get("event") == "subscribed":
                print(f"Subscribed: {msg['id']}")
                continue

            if msg.get("event") == "data":
                count += 1
                d = msg["data"]
                print(f"#{count}  {d['symbol']}  ${d['last']}  {d.get('datetime', '')}")

            if count >= 20:
                print("-- 20 ticks received, closing --")
                break


if __name__ == "__main__":
    asyncio.run(main())
