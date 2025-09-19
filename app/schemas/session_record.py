from pydantic import BaseModel, Field
from typing import Optional, Dict, List
from datetime import datetime
from .base import TimestampModel


class SessionRecordBase(BaseModel):
    transaction: Optional[str] = None
    creation_time: Optional[datetime] = None
    protocol: Optional[str] = None
    cust_id: Optional[str] = None
    user_name: Optional[str] = None
    client_ip: Optional[str] = None
    client_side_mwg_ip: Optional[str] = None
    server_side_mwg_ip: Optional[str] = None
    server_ip: Optional[str] = None
    cl_bytes_received: Optional[int] = None
    cl_bytes_sent: Optional[int] = None
    srv_bytes_received: Optional[int] = None
    srv_bytes_sent: Optional[int] = None
    trxn_index: Optional[int] = None
    age_seconds: Optional[int] = None
    status: Optional[str] = None
    in_use: Optional[int] = None
    url: Optional[str] = None
    raw_line: Optional[str] = None


class SessionRecord(SessionRecordBase, TimestampModel):
    id: int
    proxy_id: int
    collected_at: datetime

    class Config:
        from_attributes = True


class CollectRequest(BaseModel):
    proxy_ids: List[int] = Field(min_length=1)
    defer_save: bool | None = False


class CollectResponse(BaseModel):
    requested: int
    succeeded: int
    failed: int
    errors: Dict[int, str] = Field(default_factory=dict)
    items: List[SessionRecord]
    rows: List[List[str]] = Field(default_factory=list)
    tmp_token: Optional[str] = None
    total_count: Optional[int] = None

