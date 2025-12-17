import os
import sys
import threading
import time
import webbrowser
from typing import Optional

# Ensure PyInstaller can see this import during analysis
try:
    import uvicorn  # type: ignore
except Exception:
    uvicorn = None  # type: ignore


def ensure_default_env() -> None:
    os.environ.setdefault("HOST", "127.0.0.1")
    os.environ.setdefault("PORT", "8000")
    # In frozen (PyInstaller) builds, disable docs by default to avoid missing asset errors
    if getattr(sys, "frozen", False):
        os.environ.setdefault("ENABLE_DOCS", "false")
    else:
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

    if uvicorn is None:
        print(
            (
                "[PMT] Uvicorn을 불러올 수 없습니다.\n"
                "가상환경을 활성화한 뒤 의존성을 설치하세요.\n\n"
                "Linux/macOS:\n"
                "  python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt\n\n"
                "Windows PowerShell:\n"
                "  py -3.10 -m venv .venv; .\\.venv\\Scripts\\activate; pip install -r requirements.txt\n\n"
                "대안: pip install uvicorn==0.35.0\n"
                "또는 EXE 빌드시 '--collect-all uvicorn' 혹은 PyInstaller hook을 추가하세요.\n"
            ),
            file=sys.stderr,
        )
        sys.exit(1)

    # Import the app object directly to avoid module resolution issues in frozen builds
    try:
        from app.main import app as asgi_app
    except Exception as exc:
        print(f"[PMT] ASGI 앱(app.main:app) 가져오기 실패: {exc}", file=sys.stderr)
        sys.exit(1)

    # Force asyncio loop policy on Windows (Proactor may break some libs)
    try:
        if sys.platform.startswith("win"):
            import asyncio
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # type: ignore[attr-defined]
    except Exception:
        pass

    uvicorn.run(
        asgi_app,
        host=host,
        port=port,
        reload=False,
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()

