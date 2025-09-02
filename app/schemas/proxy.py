from pydantic import BaseModel, conint
from datetime import datetime

class ProxyBase(BaseModel):
    host: str
    port: conint(ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    is_active: bool = True
    group_id: int | None = None
    description: str | None = None

class ProxyCreate(ProxyBase):
    pass

class ProxyUpdate(ProxyBase):
    pass

class Proxy(ProxyBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
