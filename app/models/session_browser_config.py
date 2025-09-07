from sqlalchemy import Column, Integer, String, DateTime
from app.database.database import Base
from app.utils.time import now_kst


class SessionBrowserConfig(Base):
    __tablename__ = "session_browser_config"

    id = Column(Integer, primary_key=True, index=True)
    ssh_port = Column(Integer, nullable=False, default=22)
    command_path = Column(String, nullable=False, default="/opt/mwg/bin/mwg-core")
    command_args = Column(String, nullable=False, default="-S connections")
    timeout_sec = Column(Integer, nullable=False, default=10)
    host_key_policy = Column(String, nullable=False, default="auto_add")  # auto_add | reject
    max_workers = Column(Integer, nullable=False, default=4)

    created_at = Column(DateTime(timezone=True), default=now_kst)
    updated_at = Column(DateTime(timezone=True), onupdate=now_kst, default=now_kst)

