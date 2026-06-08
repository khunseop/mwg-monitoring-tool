from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from pathlib import Path


def _resolve_db_url() -> str:
    url = os.getenv("DATABASE_URL", "sqlite:///./pmt.db")
    # SQLite 경로에서 디렉토리가 없으면 자동 생성
    if url.startswith("sqlite:///"):
        raw = url[len("sqlite:///"):]
        if raw and raw not in (":memory:", ""):
            p = Path(raw)
            if not p.is_absolute():
                # PyInstaller frozen 환경에서는 실행 파일 기준 경로 사용
                import sys
                base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
                p = base / p
            p.parent.mkdir(parents=True, exist_ok=True)
            # 절대 경로로 URL 재구성 (슬래시 통일)
            url = "sqlite:///" + p.as_posix()
    return url


SQLALCHEMY_DATABASE_URL = _resolve_db_url()
POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "10"))
POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30"))
POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))  # seconds

is_sqlite = SQLALCHEMY_DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if is_sqlite else {}

engine_kwargs = {
    "connect_args": connect_args,
    "pool_pre_ping": True,
}

if not is_sqlite:
    engine_kwargs.update(
        {
            "pool_size": POOL_SIZE,
            "max_overflow": MAX_OVERFLOW,
            "pool_timeout": POOL_TIMEOUT,
            "pool_recycle": POOL_RECYCLE,
        }
    )

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    **engine_kwargs,
)

# For SQLite, use DELETE journal mode (no auxiliary -wal/-shm files) with tuned settings.
# WAL mode is avoided because deployments that clean up extra files can corrupt the DB
# by deleting -wal/-shm before a proper checkpoint.
if is_sqlite:
    try:
        from sqlalchemy import event
        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=DELETE")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA cache_size=-64000")  # 64MB cache
            cursor.execute("PRAGMA temp_store=MEMORY")
            cursor.execute("PRAGMA busy_timeout=30000")  # 30s timeout
            cursor.close()
    except Exception:
        pass
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
