from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.sql import func
from app.database.database import Base


class ResourceConfig(Base):
    __tablename__ = "resource_config"

    id = Column(Integer, primary_key=True, index=True)
    community = Column(String, nullable=False, default="public")
    oids_json = Column(Text, nullable=False, default='{}')  # json string mapping
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

