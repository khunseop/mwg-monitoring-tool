from pydantic import BaseModel, Field, field_validator
from typing import Optional, Dict, List, Literal
from datetime import datetime
import json
from .base import TimestampModel


class ResourceUsageBase(BaseModel):
    cpu: Optional[float] = None
    mem: Optional[float] = None
    cc: Optional[float] = None
    cs: Optional[float] = None
    http: Optional[float] = None
    https: Optional[float] = None
    ftp: Optional[float] = None
    interface_mbps: Optional[Dict[str, Dict[str, float]]] = None  # {interface_index: {"in_mbps": float, "out_mbps": float}}


class ResourceUsage(ResourceUsageBase, TimestampModel):
    id: int
    proxy_id: int
    community: Optional[str] = None
    oids_raw: Optional[str] = None
    collected_at: datetime

    @field_validator('interface_mbps', mode='before')
    @classmethod
    def parse_interface_mbps(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return None
        return v

    class Config:
        from_attributes = True


class ResourceUsageCreate(BaseModel):
    proxy_id: int
    community: Optional[str] = Field(default="public")
    # Map of metric key to OID string. Supported keys: cpu, mem, cc, cs, http, https, ftp
    oids: Dict[str, str]


class CollectRequest(BaseModel):
    # List of proxy IDs to collect (required)
    proxy_ids: List[int]
    # Community string (required)
    community: str = Field(min_length=1)
    # OIDs mapping (keys: cpu, mem, cc, cs, http, https, ftp) (required)
    oids: Dict[str, str]


class CollectResponse(BaseModel):
    requested: int
    succeeded: int
    failed: int
    errors: Dict[int, str] = Field(default_factory=dict)
    items: List[ResourceUsage]


"""
Raw timeseries schemas (since start time). Points are raw collected rows, not aggregated.
"""

class SeriesPoint(BaseModel):
    ts: datetime
    cpu: Optional[float] = None
    mem: Optional[float] = None
    cc: Optional[float] = None
    cs: Optional[float] = None
    http: Optional[float] = None
    https: Optional[float] = None
    ftp: Optional[float] = None


class SeriesItem(BaseModel):
    proxy_id: int
    points: List[SeriesPoint]


class SeriesRequest(BaseModel):
    proxy_ids: List[int]
    start: datetime
    end: Optional[datetime] = None


class SeriesResponse(BaseModel):
    items: List[SeriesItem]

