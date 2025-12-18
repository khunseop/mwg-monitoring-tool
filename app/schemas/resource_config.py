from pydantic import BaseModel, Field
from typing import Dict, Optional, List
from .base import TimestampModel


class ResourceConfigBase(BaseModel):
    community: str = Field(default="public", min_length=1)
    oids: Dict[str, str] = Field(default_factory=dict)
    thresholds: Dict[str, float] = Field(default_factory=dict)
    interface_oids: Dict[str, Dict[str, str]] = Field(default_factory=dict, description="인터페이스별 OID 설정 {인터페이스명: {in_oid: OID, out_oid: OID}}")
    interface_thresholds: Dict[str, float] = Field(default_factory=dict, description="인터페이스별 임계치 설정 {인터페이스명: 임계치}")
    bandwidth_mbps: Optional[float] = Field(default=1000.0, description="회선 대역폭 (Mbps), 기본값 1000 (1Gbps)")


class ResourceConfig(ResourceConfigBase, TimestampModel):
    id: int

    class Config:
        from_attributes = True

