from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Float, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.database import Base


class ResourceUsage(Base):
    __tablename__ = "resource_usage"

    id = Column(Integer, primary_key=True, index=True)
    proxy_id = Column(Integer, ForeignKey("proxies.id", ondelete="CASCADE"), nullable=False, index=True)

    # Metrics (nullable: if some OIDs not provided/queried)
    cpu = Column(Float, nullable=True)
    mem = Column(Float, nullable=True)
    cc = Column(Float, nullable=True)
    cs = Column(Float, nullable=True)
    http = Column(Float, nullable=True)
    https = Column(Float, nullable=True)
    ftp = Column(Float, nullable=True)

    # SNMP context
    community = Column(String, nullable=True)
    oids_raw = Column(Text, nullable=True)  # json string of oid mapping used for collection

    collected_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    proxy = relationship("Proxy", backref="resource_usages")

