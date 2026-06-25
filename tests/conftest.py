"""공통 테스트 픽스처 — 인메모리 SQLite DB + TestClient"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from sqlalchemy.pool import StaticPool
from app.database.database import get_db, Base

# 모든 모델을 임포트해서 Base.metadata에 등록
import app.models.proxy  # noqa: F401
import app.models.proxy_group  # noqa: F401
import app.models.resource_usage  # noqa: F401
import app.models.resource_config  # noqa: F401
import app.models.session_browser_config  # noqa: F401
import app.models.traffic_log  # noqa: F401

# StaticPool: 인메모리 SQLite에서 모든 연결이 같은 DB를 공유
test_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


def _get_test_db():
    db = TestSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="session", autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture()
def client():
    from app.main import app
    app.dependency_overrides[get_db] = _get_test_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()
