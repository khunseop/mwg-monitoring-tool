from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.database.database import Base
from app.utils.time import now_kst

class Proxy(Base):
    __tablename__ = "proxies"

    id = Column(Integer, primary_key=True, index=True)
    host = Column(String, nullable=False, unique=True)
    port = Column(Integer, nullable=False, default=22)
    username = Column(String, nullable=True)
    password = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    group_id = Column(Integer, ForeignKey("proxy_groups.id", ondelete="SET NULL"), nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=now_kst)
    updated_at = Column(DateTime(timezone=True), onupdate=now_kst, default=now_kst)

    group = relationship("ProxyGroup", backref="proxies")

    @property
    def group_name(self) -> str | None:
        return self.group.name if self.group else None
