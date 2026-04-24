import asyncio
import websockets
import mss
import base64
import json
import io
from PIL import Image


async def handler(websocket):
    print(f"Client connected: {websocket.remote_address}")
    try:
        async for message in websocket:
            with mss.mss() as sct:
                monitor = sct.monitors[1]
                raw = sct.grab(monitor)
                img = Image.frombytes('RGB', raw.size, raw.bgra, 'raw', 'BGRX')
                img.thumbnail((1280, 720), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=75)
                b64 = base64.b64encode(buf.getvalue()).decode()
                await websocket.send(json.dumps({"screenshot": b64}))
                print("Screenshot sent")
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")


async def main():
    print("G2 Screen server running on ws://0.0.0.0:8765")
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()


asyncio.run(main())
