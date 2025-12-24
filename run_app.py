import os
import sys
import threading
import time
import webbrowser
from typing import Optional

# Fix stdin/stdout/stderr for PyInstaller builds (especially --noconsole)
if getattr(sys, "frozen", False):
    # PyInstaller 빌드 환경에서 표준 스트림이 None일 수 있음
    if sys.stdin is None:
        import io
        sys.stdin = io.StringIO()
    if sys.stdout is None:
        import io
        sys.stdout = io.StringIO()
    if sys.stderr is None:
        import io
        sys.stderr = io.StringIO()

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
        # PyInstaller 빌드에서 콘솔이 있는지 확인
        has_console = True
        try:
            if sys.stdout is None or not hasattr(sys.stdout, 'isatty'):
                has_console = False
            else:
                # isatty() 호출 시 에러가 발생하면 콘솔 없음
                try:
                    sys.stdout.isatty()
                except (AttributeError, OSError, ValueError):
                    has_console = False
        except Exception:
            has_console = False
        
        # 콘솔이 있으면 콘솔 로깅 활성화, 없으면 파일만 사용
        if has_console:
            os.environ.setdefault("LOG_TO_CONSOLE", "true")
        else:
            os.environ.setdefault("LOG_TO_CONSOLE", "false")
        os.environ.setdefault("LOG_TO_FILE", "true")
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

    # PyInstaller 빌드 환경에서 uvicorn 로깅 설정 조정
    log_config = None
    if getattr(sys, "frozen", False):
        # PyInstaller 빌드에서는 uvicorn의 기본 로깅 설정을 사용하지 않음
        # (로깅은 app.utils.logging_config에서 이미 설정됨)
        import logging
        from pathlib import Path
        
        # 로그 디렉토리 확인 및 생성
        log_dir = Path("logs")
        log_dir.mkdir(exist_ok=True)
        
        # 안전한 핸들러 선택 (stdout이 사용 가능한지 확인)
        handler_class = "logging.FileHandler"
        handler_config = {
            "filename": str(log_dir / "pmt_uvicorn.log"),
            "mode": "a",
            "encoding": "utf-8",
        }
        
        try:
            # stdout이 사용 가능하고 isatty()가 작동하는지 확인
            if (sys.stdout is not None and 
                hasattr(sys.stdout, 'isatty') and 
                callable(getattr(sys.stdout, 'isatty', None))):
                try:
                    sys.stdout.isatty()
                    # isatty()가 성공하면 StreamHandler 사용 가능
                    handler_class = "logging.StreamHandler"
                    handler_config = {
                        "stream": "ext://sys.stdout",
                    }
                except (AttributeError, OSError, ValueError):
                    # isatty() 실패 시 FileHandler 사용
                    pass
        except Exception:
            # 모든 예외 시 FileHandler 사용
            pass
        
        log_config = {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
                    "datefmt": "%Y-%m-%d %H:%M:%S",
                },
            },
            "handlers": {
                "default": {
                    "class": handler_class,
                    "formatter": "default",
                    **handler_config,
                },
            },
            "root": {
                "level": "INFO",
                "handlers": ["default"],
            },
            "loggers": {
                "uvicorn": {
                    "level": "WARNING",
                    "handlers": ["default"],
                    "propagate": False,
                },
                "uvicorn.access": {
                    "level": "WARNING",
                    "handlers": ["default"],
                    "propagate": False,
                },
            },
        }

    uvicorn.run(
        asgi_app,
        host=host,
        port=port,
        reload=False,
        access_log=False,
        log_level="info",
        log_config=log_config,
    )


if __name__ == "__main__":
    main()

