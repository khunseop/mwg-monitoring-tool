from sqlalchemy import Column, Integer, String, DateTime, Text
from sqlalchemy.sql import func
from app.database.database import Base

class ProxyGroup(Base):
    __tablename__ = "proxy_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    @property
    def proxies_count(self) -> int:
        return len(self.proxies) if hasattr(self, 'proxies') else 0

    @proxies_count.setter
    def proxies_count(self, value: int):
        # 이 setter는 스키마 매핑을 위해 필요합니다
        pass
