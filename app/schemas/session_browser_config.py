from pydantic import BaseModel, conint
from datetime import datetime
from typing import Optional
from .base import TimestampModel


class SessionBrowserConfigBase(BaseModel):
    ssh_port: conint(ge=1, le=65535) = 22
    command_path: str = "/opt/mwg/bin/mwg-core"
    command_args: str = "-S connections"
    timeout_sec: conint(ge=1, le=120) = 10
    host_key_policy: str = "auto_add"  # auto_add | reject


class SessionBrowserConfig(SessionBrowserConfigBase, TimestampModel):
    id: int

    class Config:
        from_attributes = True

