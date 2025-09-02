from pydantic import BaseModel
from datetime import datetime

class TimestampModel(BaseModel):
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
