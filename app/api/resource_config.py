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
    # parse oids and embedded thresholds/selected_interfaces
    oids = json.loads(cfg.oids_json or '{}')
    thresholds = {}
    selected_interfaces = []
    if isinstance(oids, dict) and isinstance(oids.get('__thresholds__'), dict):
        thresholds = oids.get('__thresholds__') or {}
    if isinstance(oids, dict) and isinstance(oids.get('__selected_interfaces__'), list):
        selected_interfaces = oids.get('__selected_interfaces__') or []
    # filter out embedded keys when returning oids
    if isinstance(oids, dict):
        oids = {k: v for k, v in oids.items() if k not in ['__thresholds__', '__selected_interfaces__']}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids,
        thresholds=thresholds,
        selected_interfaces=selected_interfaces,
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
    # Store oids; also embed thresholds and selected_interfaces (single source of truth)
    oids = payload.oids or {}
    thresholds = payload.thresholds or {}
    selected_interfaces = payload.selected_interfaces or []
    # Preserve previous thresholds/selected_interfaces when client sends empty values
    try:
        current = json.loads(cfg.oids_json or '{}')
        if not thresholds and isinstance(current, dict) and isinstance(current.get('__thresholds__'), dict):
            thresholds = current.get('__thresholds__') or {}
        if not selected_interfaces and isinstance(current, dict) and isinstance(current.get('__selected_interfaces__'), list):
            selected_interfaces = current.get('__selected_interfaces__') or []
    except Exception:
        pass
    merged = dict(oids)
    # always embed thresholds and selected_interfaces (may be empty) to ensure persistence in oids_json
    merged['__thresholds__'] = thresholds
    merged['__selected_interfaces__'] = selected_interfaces
    cfg.oids_json = json.dumps(merged)
    db.commit()
    db.refresh(cfg)
    # Build response splitting embedded thresholds and selected_interfaces back out
    oids_out = json.loads(cfg.oids_json or '{}')
    thresholds_out = {}
    selected_interfaces_out = []
    if isinstance(oids_out, dict):
        if '__thresholds__' in oids_out:
            thresholds_out = oids_out.get('__thresholds__') or {}
        if '__selected_interfaces__' in oids_out:
            selected_interfaces_out = oids_out.get('__selected_interfaces__') or []
        oids_out = {k: v for k, v in oids_out.items() if k not in ['__thresholds__', '__selected_interfaces__']}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids_out,
        thresholds=thresholds_out,
        selected_interfaces=selected_interfaces_out,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )

