from pydantic import BaseModel, conint
from datetime import datetime
from typing import Optional
from .base import TimestampModel

class ProxyBase(BaseModel):
    host: str
    port: conint(ge=1, le=65535)
    username: str
    password: str | None = None
    is_active: bool = True
    group_id: int | None = None
    description: str | None = None

class ProxyCreate(ProxyBase):
    pass

class ProxyUpdate(BaseModel):
    host: Optional[str] = None
    port: Optional[conint(ge=1, le=65535)] = None
    username: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None
    group_id: Optional[int] = None
    description: Optional[str] = None

class ProxyOut(TimestampModel):
    id: int
    host: str
    port: conint(ge=1, le=65535)
    username: Optional[str] = None
    is_active: bool = True
    group_id: Optional[int] = None
    description: Optional[str] = None
    group_name: Optional[str] = None

    class Config:
        from_attributes = True