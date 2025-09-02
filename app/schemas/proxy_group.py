from pydantic import BaseModel
from datetime import datetime
from typing import List, Optional
from .proxy import Proxy

class ProxyGroupBase(BaseModel):
    name: str
    description: Optional[str] = None

class ProxyGroupCreate(ProxyGroupBase):
    pass

class ProxyGroupUpdate(ProxyGroupBase):
    pass

class ProxyGroup(ProxyGroupBase):
    id: int
    created_at: datetime
    updated_at: datetime
    proxies: List[Proxy] = []

    class Config:
        from_attributes = True
