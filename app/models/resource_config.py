from sqlalchemy import Column, Integer, String, Text, DateTime
from app.database.database import Base
from app.utils.time import now_kst


class ResourceConfig(Base):
    __tablename__ = "resource_config"

    id = Column(Integer, primary_key=True, index=True)
    community = Column(String, nullable=False, default="public")
    oids_json = Column(Text, nullable=False, default='{}')  # json string mapping
    created_at = Column(DateTime(timezone=True), default=now_kst)
    updated_at = Column(DateTime(timezone=True), onupdate=now_kst, default=now_kst)

