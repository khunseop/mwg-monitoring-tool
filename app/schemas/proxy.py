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
    host: str
    port: conint(ge=1, le=65535)
    username: str
    password: str | None = None  # 수정 시 비밀번호는 선택적
    is_active: bool = True
    group_id: int | None = None
    description: str | None = None

class Proxy(ProxyBase, TimestampModel):
    id: int
    group_name: Optional[str] = None  # 그룹 이름만 포함

    class Config:
        from_attributes = True