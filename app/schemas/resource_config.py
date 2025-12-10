from pydantic import BaseModel, Field
from typing import Dict, Optional, List
from .base import TimestampModel


class ResourceConfigBase(BaseModel):
    community: str = Field(default="public", min_length=1)
    oids: Dict[str, str] = Field(default_factory=dict)
    thresholds: Dict[str, float] = Field(default_factory=dict)
    selected_interfaces: List[str] = Field(default_factory=list)  # List of interface indices to display
    bandwidth_mbps: Optional[float] = Field(default=1000.0, description="회선 대역폭 (Mbps), 기본값 1000 (1Gbps)")


class ResourceConfig(ResourceConfigBase, TimestampModel):
    id: int

    class Config:
        from_attributes = True

