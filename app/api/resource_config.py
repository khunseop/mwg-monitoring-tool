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
        cfg = ResourceConfigModel(community="public", oids_json='{}', thresholds_json='{}')
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=json.loads(cfg.oids_json or '{}'),
        thresholds=json.loads(getattr(cfg, 'thresholds_json', '{}') or '{}'),
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
    cfg.oids_json = json.dumps(payload.oids or {})
    # thresholds optional
    try:
        cfg.thresholds_json = json.dumps(payload.thresholds or {})
    except Exception:
        cfg.thresholds_json = json.dumps({})
    db.commit()
    db.refresh(cfg)
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=json.loads(cfg.oids_json or '{}'),
        thresholds=json.loads(getattr(cfg, 'thresholds_json', '{}') or '{}'),
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )

