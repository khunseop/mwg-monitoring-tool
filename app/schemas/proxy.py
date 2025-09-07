from pydantic import BaseModel, conint, constr
from datetime import datetime
from typing import Optional
from .base import TimestampModel


# Simple host validator: allows domain names (letters, digits, hyphens, dots)
# or IPv4 addresses. This is intentionally permissive and fast.
HostnameOrIPv4 = constr(pattern=r"^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|(?:\d{1,3}\.){3}\d{1,3})$")

class ProxyBase(BaseModel):
    host: HostnameOrIPv4
    port: conint(ge=1, le=65535)
    username: constr(min_length=1)
    password: str | None = None
    is_active: bool = True
    group_id: int | None = None
    description: str | None = None

class ProxyCreate(ProxyBase):
    pass

class ProxyUpdate(BaseModel):
    host: Optional[HostnameOrIPv4] = None
    port: Optional[conint(ge=1, le=65535)] = None
    username: Optional[constr(min_length=1)] = None
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