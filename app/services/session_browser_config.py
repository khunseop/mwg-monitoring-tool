from sqlalchemy.orm import Session

from app.models.session_browser_config import SessionBrowserConfig as SessionBrowserConfigModel
from app.schemas.session_browser_config import (
    SessionBrowserConfig as SessionBrowserConfigSchema,
    SessionBrowserConfigUpdateSafe,
)


def get_or_create_config(db: Session) -> SessionBrowserConfigModel:
    cfg = (
        db.query(SessionBrowserConfigModel)
        .order_by(SessionBrowserConfigModel.id.asc())
        .first()
    )
    if not cfg:
        cfg = SessionBrowserConfigModel()
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def to_schema(cfg: SessionBrowserConfigModel) -> SessionBrowserConfigSchema:
    return SessionBrowserConfigSchema(
        id=cfg.id,
        ssh_port=cfg.ssh_port,
        command_path=cfg.command_path,
        command_args=cfg.command_args,
        timeout_sec=cfg.timeout_sec,
        host_key_policy=cfg.host_key_policy,
        max_workers=cfg.max_workers,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )


def update_config_safe(
    cfg: SessionBrowserConfigModel, payload: SessionBrowserConfigUpdateSafe
) -> None:
    # Only allow safe fields to update; prevent command_path/command_args modifications
    cfg.ssh_port = payload.ssh_port
    cfg.timeout_sec = payload.timeout_sec
    cfg.host_key_policy = payload.host_key_policy
    cfg.max_workers = payload.max_workers
