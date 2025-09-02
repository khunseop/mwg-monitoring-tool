from pydantic import BaseModel
from datetime import datetime
from typing import List
from .base import TimestampModel

class ProxyGroupBase(BaseModel):
    name: str
    description: str | None = None

class ProxyGroupCreate(ProxyGroupBase):
    pass

class ProxyGroupUpdate(ProxyGroupBase):
    pass

class ProxyGroup(ProxyGroupBase, TimestampModel):
    id: int
    proxies_count: int

    class Config:
        from_attributes = True