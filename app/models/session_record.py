from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.database import Base


class SessionRecord(Base):
    __tablename__ = "session_records"

    id = Column(Integer, primary_key=True, index=True)
    proxy_id = Column(Integer, ForeignKey("proxies.id", ondelete="CASCADE"), nullable=False, index=True)

    # Columns as provided by MWG session browser output
    transaction = Column(String, nullable=True)
    creation_time = Column(String, nullable=True)  # keep raw string; parser can also provide parsed_at if needed
    protocol = Column(String, nullable=True)
    cust_id = Column(String, nullable=True)
    user_name = Column(String, nullable=True)
    client_ip = Column(String, nullable=True)
    client_side_mwg_ip = Column(String, nullable=True)
    server_side_mwg_ip = Column(String, nullable=True)
    server_ip = Column(String, nullable=True)

    cl_bytes_received = Column(Integer, nullable=True)
    cl_bytes_sent = Column(Integer, nullable=True)
    srv_bytes_received = Column(Integer, nullable=True)
    srv_bytes_sent = Column(Integer, nullable=True)

    trxn_index = Column(Integer, nullable=True)
    age_seconds = Column(Integer, nullable=True)
    status = Column(String, nullable=True)
    in_use = Column(Integer, nullable=True)  # 0/1 as provided
    url = Column(Text, nullable=True)

    # Raw line for debug/troubleshooting
    raw_line = Column(Text, nullable=True)

    collected_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    proxy = relationship("Proxy", backref="session_records")

