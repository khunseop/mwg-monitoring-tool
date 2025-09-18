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

    try:
        import uvicorn
    except Exception:
        print(
            (
                "[PPAT] Uvicorn을 불러올 수 없습니다.\n"
                "가상환경을 활성화한 뒤 의존성을 설치하세요.\n\n"
                "Linux/macOS:\n"
                "  python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt\n\n"
                "Windows PowerShell:\n"
                "  py -3.10 -m venv .venv; .\\.venv\\Scripts\\activate; pip install -r requirements.txt\n\n"
                "대안: pip install uvicorn==0.35.0\n"
            ),
            file=sys.stderr,
        )
        sys.exit(1)

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

