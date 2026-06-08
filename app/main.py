from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
import os
from dotenv import load_dotenv
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from app.database.database import engine
from app.models import proxy, proxy_group
from app.models import resource_usage as resource_usage_model
from app.models import resource_config as resource_config_model
from app.models import session_browser_config as session_browser_config_model
from app.models import traffic_log as traffic_log_model
from app.api import proxies, proxy_groups, config_management
from app.api import resource_usage as resource_usage_api
from app.api import resource_config as resource_config_api
from app.api import session_browser as session_browser_api
from app.api import session_browser_config as session_browser_config_api
from app.api import traffic_logs as traffic_logs_api
from fastapi_standalone_docs import StandaloneDocs
import warnings
from sqlalchemy import text, inspect
from sqlalchemy.exc import OperationalError
try:
    from cryptography.utils import CryptographyDeprecationWarning
    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except Exception:
    pass
from app.database.database import SessionLocal
from app.models.proxy import Proxy as ProxyModel
from app.utils.crypto import encrypt_string
from app.utils.path_resolver import get_templates_dir, get_static_dir, get_docs_dir
from app.utils.logging_config import setup_logging

# Load environment variables from .env
load_dotenv(override=False)

# 로깅 초기화 (환경변수 로드 후 가장 먼저 실행)
setup_logging()

import logging as _logging
_startup_logger = _logging.getLogger(__name__)


def _recover_sqlite_db(db_url: str) -> None:
    """SQLite DB가 손상된 경우 자동 복구를 시도합니다."""
    import sqlite3, shutil, re

    # sqlite:///./path.db 또는 sqlite:////abs/path.db 형태에서 파일 경로 추출
    m = re.match(r"sqlite:///(.+)", db_url)
    if not m:
        return
    db_path = m.group(1)
    if not os.path.exists(db_path):
        return  # 신규 파일이면 복구 불필요

    # 1단계: 무결성 확인
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        # WAL 체크포인트 시도 (이전 WAL 잔재 처리)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass
        result = conn.execute("PRAGMA integrity_check").fetchone()
        conn.close()
        if result and result[0] == "ok":
            return  # 정상
        _startup_logger.error("[DB] integrity_check 실패: %s — 복구를 시도합니다.", result)
    except Exception as e:
        _startup_logger.error("[DB] DB 열기 실패: %s — 복구를 시도합니다.", e)

    # 2단계: iterdump()로 데이터 추출 후 새 DB 재생성
    recovered_path = db_path + ".recovered"
    try:
        src = sqlite3.connect(db_path, timeout=5)
        dst = sqlite3.connect(recovered_path, timeout=5)
        try:
            for line in src.iterdump():
                try:
                    dst.execute(line)
                except Exception:
                    pass  # 손상 행 스킵
            dst.commit()
        finally:
            src.close()
            dst.close()

        corrupt_path = db_path + ".corrupt"
        shutil.move(db_path, corrupt_path)
        shutil.move(recovered_path, db_path)
        # 남은 WAL/SHM 정리
        for ext in ("-wal", "-shm"):
            try:
                os.remove(db_path + ext)
            except OSError:
                pass
        _startup_logger.warning(
            "[DB] DB 복구 완료. 손상 파일: %s → 복구 파일: %s", corrupt_path, db_path
        )
    except Exception as e:
        # 3단계: 복구 불가 → 백업 후 빈 DB로 시작
        _startup_logger.critical("[DB] iterdump 복구 실패: %s — 빈 DB로 새로 시작합니다.", e)
        try:
            shutil.move(db_path, db_path + ".unrecoverable")
        except Exception:
            pass
        try:
            os.remove(recovered_path)
        except OSError:
            pass


_recover_sqlite_db(os.getenv("DATABASE_URL", "sqlite:///./pmt.db"))

proxy.Base.metadata.create_all(bind=engine)
resource_usage_model.Base.metadata.create_all(bind=engine)
resource_config_model.Base.metadata.create_all(bind=engine)
session_browser_config_model.Base.metadata.create_all(bind=engine)
traffic_log_model.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="PMT",
    description="Proxy Monitoring Tool",
    version="2026.06.07"
)
# Security/CORS middleware (configure via env)
cors_origins = os.getenv("CORS_ALLOW_ORIGINS", "*")
allow_origins = [o.strip() for o in cors_origins.split(",") if o.strip()]
allow_credentials_env = os.getenv("CORS_ALLOW_CREDENTIALS", "false").lower() in {"1", "true", "yes"}
# Starlette forbids wildcard origins with credentials; disable credentials if wildcard is present
allow_credentials = False if ("*" in allow_origins and len(allow_origins) == 1) else allow_credentials_env
from fastapi.middleware.gzip import GZipMiddleware
...
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
# Enable docs only when enabled via env (default true)
if os.getenv("ENABLE_DOCS", "true").lower() in {"1", "true", "yes"}:
    StandaloneDocs(app)
    # expose version in app state for templates
app.github_url = os.getenv("GITHUB_URL")

# 템플릿과 정적 파일 설정 (dev/pyinstaller 모두 지원)
templates = Jinja2Templates(directory=get_templates_dir())
app.mount("/static", StaticFiles(directory=get_static_dir()), name="static")
app.mount("/docs-static", StaticFiles(directory=get_docs_dir()), name="docs-static")

# API 라우터
app.include_router(proxies.router, prefix="/api", tags=["proxies"])
app.include_router(proxy_groups.router, prefix="/api", tags=["proxy-groups"])
app.include_router(resource_usage_api.router, prefix="/api", tags=["resource-usage"])
app.include_router(resource_config_api.router, prefix="/api", tags=["resource-config"])
app.include_router(session_browser_api.router, prefix="/api", tags=["session-browser"])
app.include_router(session_browser_config_api.router, prefix="/api", tags=["session-browser-config"])
app.include_router(traffic_logs_api.router, prefix="/api", tags=["traffic-logs"])
app.include_router(config_management.router, prefix="/api", tags=["config"])

# 페이지 라우터
@app.get("/")
async def read_root(request: Request):
    # 기본 라우트를 자원사용률 페이지로 제공
    return templates.TemplateResponse("components/resource_usage.html", {"request": request})

@app.get("/resource")
async def read_resource(request: Request):
    return templates.TemplateResponse("components/resource_usage.html", {"request": request})

@app.get("/history")
async def read_resource_history(request: Request):
    return templates.TemplateResponse("components/resource_usage.html", {"request": request})

@app.get("/resource/history")
async def read_resource_history_redirect(request: Request):
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/history", status_code=301)

@app.get("/resource-history")
async def read_resource_history_legacy(request: Request):
    # 레거시 URL 리다이렉트
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/history", status_code=301)

@app.get("/proxy")
async def read_proxy_management(request: Request):
    return templates.TemplateResponse("components/proxy_management.html", {"request": request})

@app.get("/proxy/groups")
async def read_proxy_groups(request: Request):
    return templates.TemplateResponse("components/proxy_management.html", {"request": request})

@app.get("/settings")
async def read_settings(request: Request):
    return templates.TemplateResponse("components/settings.html", {"request": request})

@app.get("/session")
async def read_session(request: Request):
    return templates.TemplateResponse("components/session_browser.html", {"request": request})


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/traffic-logs")
async def read_traffic_logs_page(request: Request):
    return templates.TemplateResponse("components/traffic_logs.html", {"request": request})

@app.get("/traffic-logs/upload")
async def read_traffic_logs_upload(request: Request):
    return templates.TemplateResponse("components/traffic_logs.html", {"request": request})


# Minimal security headers
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    return response


# One-time startup task: migrate legacy plaintext proxy passwords to encrypted format
@app.on_event("startup")
def migrate_legacy_proxy_passwords():
    try:
        db = SessionLocal()
        try:
            rows = db.query(ProxyModel).all()
            changed = 0
            for row in rows:
                pw = getattr(row, "password", None)
                if pw and not str(pw).strip().startswith("enc$"):
                    row.password = encrypt_string(pw)
                    changed += 1
            if changed:
                db.commit()
        finally:
            db.close()
    except Exception:
        # avoid breaking startup due to migration failure
        pass


# (removed) one-time startup cleanup for legacy accumulated rows

# Start retention policy background task on startup
@app.on_event("startup")
async def start_background_tasks():
    from app.utils.background_collector import background_collector
    # Start retention policy task (runs every hour)
    await background_collector.start_retention_policy(interval_sec=3600)

@app.on_event("shutdown")
async def stop_background_tasks():
    from app.utils.background_collector import background_collector
    # Stop retention policy task
    await background_collector.stop_retention_policy()
