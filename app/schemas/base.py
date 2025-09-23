from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class TimestampModel(BaseModel):
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
