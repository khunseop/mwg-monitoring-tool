from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import json

from app.database.database import get_db
from app.models.resource_config import ResourceConfig as ResourceConfigModel
from app.schemas.resource_config import ResourceConfig as ResourceConfigSchema, ResourceConfigBase


router = APIRouter()


def _get_singleton(db: Session) -> ResourceConfigModel | None:
    return db.query(ResourceConfigModel).order_by(ResourceConfigModel.id.asc()).first()


@router.get("/resource-config", response_model=ResourceConfigSchema)
def get_resource_config(db: Session = Depends(get_db)):
    cfg = _get_singleton(db)
    if not cfg:
        # create default
        cfg = ResourceConfigModel(community="public", oids_json='{}')
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    # parse oids and embedded thresholds fallback
    oids = json.loads(cfg.oids_json or '{}')
    thresholds = {}
    try:
        thresholds = json.loads(getattr(cfg, 'thresholds_json', '{}') or '{}')
    except Exception:
        thresholds = {}
    if not thresholds and isinstance(oids, dict) and isinstance(oids.get('__thresholds__'), dict):
        thresholds = oids.get('__thresholds__') or {}
    # filter out embedded key when returning oids
    if isinstance(oids, dict) and '__thresholds__' in oids:
        oids = {k: v for k, v in oids.items() if k != '__thresholds__'}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids,
        thresholds=thresholds,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )


@router.put("/resource-config", response_model=ResourceConfigSchema)
def update_resource_config(payload: ResourceConfigBase, db: Session = Depends(get_db)):
    cfg = _get_singleton(db)
    if not cfg:
        cfg = ResourceConfigModel()
        db.add(cfg)
    cfg.community = payload.community
    # Store oids; also embed thresholds for backward/compat (to avoid DB migrations)
    oids = payload.oids or {}
    thresholds = payload.thresholds or {}
    merged = dict(oids)
    # only embed when not empty
    if thresholds:
        merged['__thresholds__'] = thresholds
    cfg.oids_json = json.dumps(merged)
    db.commit()
    db.refresh(cfg)
    # Build response splitting embedded thresholds back out
    oids_out = json.loads(cfg.oids_json or '{}')
    thresholds_out = {}
    if isinstance(oids_out, dict) and '__thresholds__' in oids_out:
        thresholds_out = oids_out.get('__thresholds__') or {}
        oids_out = {k: v for k, v in oids_out.items() if k != '__thresholds__'}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids_out,
        thresholds=thresholds_out,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )

