from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.database import get_db
from app.schemas.session_browser_config import (
    SessionBrowserConfig as SessionBrowserConfigSchema,
    SessionBrowserConfigUpdateSafe,
)
from app.services.session_browser_config import (
    get_or_create_config,
    to_schema,
    update_config_safe,
)


router = APIRouter()


@router.get("/session-browser/config", response_model=SessionBrowserConfigSchema)
def get_session_browser_config(db: Session = Depends(get_db)):
    cfg = get_or_create_config(db)
    return to_schema(cfg)


@router.put("/session-browser/config", response_model=SessionBrowserConfigSchema)
def update_session_browser_config(
    payload: SessionBrowserConfigUpdateSafe, db: Session = Depends(get_db)
):
    cfg = get_or_create_config(db)
    update_config_safe(cfg, payload)
    db.commit()
    db.refresh(cfg)
    return to_schema(cfg)

