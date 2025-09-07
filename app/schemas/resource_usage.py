from pydantic import BaseModel, Field
from typing import Optional, Dict, List, Literal
from datetime import datetime
from .base import TimestampModel


class ResourceUsageBase(BaseModel):
    cpu: Optional[float] = None
    mem: Optional[float] = None
    cc: Optional[float] = None
    cs: Optional[float] = None
    http: Optional[float] = None
    https: Optional[float] = None
    ftp: Optional[float] = None


class ResourceUsage(ResourceUsageBase, TimestampModel):
    id: int
    proxy_id: int
    community: Optional[str] = None
    oids_raw: Optional[str] = None
    collected_at: datetime

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


# Series/aggregation schemas
class SeriesPoint(BaseModel):
    # bucket timestamp (start of bucket)
    ts: datetime
    # averages per metric in this bucket
    avg: Dict[str, Optional[float]]
    # moving average (window) per metric
    ma: Dict[str, Optional[float]]
    # cumulative average up to this point per metric
    cma: Dict[str, Optional[float]]


class SeriesItem(BaseModel):
    proxy_id: int
    points: List[SeriesPoint]


class SeriesRequest(BaseModel):
    proxy_ids: List[int]
    start: datetime
    end: datetime
    interval: Literal["minute", "hour", "day"] = "minute"
    ma_window: int = Field(default=5, ge=1, le=500)


class SeriesResponse(BaseModel):
    items: List[SeriesItem]

