import os
import sys
import threading
import time
import webbrowser
from typing import Optional


def ensure_default_env() -> None:
    os.environ.setdefault("HOST", "127.0.0.1")
    os.environ.setdefault("PORT", "8000")
    os.environ.setdefault("ENABLE_DOCS", "true")


def open_browser_later(url: str, delay_sec: float = 1.0) -> None:
    def _open() -> None:
        time.sleep(delay_sec)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()


def main() -> None:
    ensure_default_env()
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    url = f"http://{host}:{port}/"

    open_browser_later(url, delay_sec=1.2)

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=False,
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()

