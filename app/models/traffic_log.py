from sqlalchemy import Column, Integer, String, Boolean, Float, DateTime
from app.database.database import Base
from datetime import datetime


class TrafficLog(Base):
    __tablename__ = "traffic_logs"

    id = Column(Integer, primary_key=True, index=True)

    # Source context
    proxy_id = Column(Integer, index=True, nullable=False)
    collected_at = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)

    # Parsed fields (mirror app/utils/traffic_log_parser.py FIELDS)
    datetime = Column(String(64), index=True)
    username = Column(String(256), index=True)
    client_ip = Column(String(64), index=True)
    url_destination_ip = Column(String(64))
    timeintransaction = Column(Float)
    response_statuscode = Column(Integer, index=True)
    cache_status = Column(String(64))
    comm_name = Column(String(128))
    url_protocol = Column(String(16))
    url_host = Column(String(512), index=True)
    url_path = Column(String(2048))
    url_parametersstring = Column(String(2048))
    url_port = Column(Integer)
    url_categories = Column(String(512))
    url_reputationstring = Column(String(128))
    url_reputation = Column(Integer)
    mediatype_header = Column(String(256))
    recv_byte = Column(Integer)
    sent_byte = Column(Integer)
    user_agent = Column(String(2048))
    referer = Column(String(2048))
    url_geolocation = Column(String(128))
    application_name = Column(String(256))
    currentruleset = Column(String(256))
    currentrule = Column(String(256))
    action_names = Column(String(256))
    block_id = Column(String(128), index=True)
    ssl_certificate_cn = Column(String(512))
    ssl_certificate_sigmethod = Column(String(128))
    web_socket = Column(Boolean)
    content_lenght = Column(Integer)

