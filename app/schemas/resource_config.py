from pydantic import BaseModel, Field
from typing import Dict, Optional
from .base import TimestampModel


class ResourceConfigBase(BaseModel):
    community: str = Field(default="public", min_length=1)
    oids: Dict[str, str] = Field(default_factory=dict)
    thresholds: Dict[str, float] = Field(default_factory=dict)


class ResourceConfig(ResourceConfigBase, TimestampModel):
    id: int

    class Config:
        from_attributes = True

