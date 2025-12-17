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
    # parse oids and embedded thresholds/interface_oids/interface_thresholds/bandwidth_mbps
    oids = json.loads(cfg.oids_json or '{}')
    thresholds = {}
    interface_oids = {}
    interface_thresholds = {}
    bandwidth_mbps = 1000.0  # default 1Gbps
    if isinstance(oids, dict) and isinstance(oids.get('__thresholds__'), dict):
        thresholds = oids.get('__thresholds__') or {}
    if isinstance(oids, dict) and isinstance(oids.get('__interface_oids__'), dict):
        interface_oids = oids.get('__interface_oids__') or {}
    if isinstance(oids, dict) and isinstance(oids.get('__interface_thresholds__'), dict):
        interface_thresholds = oids.get('__interface_thresholds__') or {}
    if isinstance(oids, dict) and isinstance(oids.get('__bandwidth_mbps__'), (int, float)):
        bandwidth_mbps = float(oids.get('__bandwidth_mbps__'))
    # filter out embedded keys when returning oids (including legacy __selected_interfaces__)
    if isinstance(oids, dict):
        oids = {k: v for k, v in oids.items() if k not in ['__thresholds__', '__interface_oids__', '__interface_thresholds__', '__bandwidth_mbps__', '__selected_interfaces__']}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids,
        thresholds=thresholds,
        interface_oids=interface_oids,
        interface_thresholds=interface_thresholds,
        bandwidth_mbps=bandwidth_mbps,
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
    # Store oids; also embed thresholds, interface_oids, interface_thresholds, and bandwidth_mbps (single source of truth)
    oids = payload.oids or {}
    
    # Check which fields were actually set in the payload (not just default values)
    payload_dict = payload.model_dump(exclude_unset=True)
    thresholds_provided = 'thresholds' in payload_dict
    interface_oids_provided = 'interface_oids' in payload_dict
    interface_thresholds_provided = 'interface_thresholds' in payload_dict
    bandwidth_mbps_provided = 'bandwidth_mbps' in payload_dict
    
    # Use provided values, or preserve previous values if not provided
    thresholds = payload.thresholds if thresholds_provided else {}
    interface_oids = payload.interface_oids if interface_oids_provided else {}
    interface_thresholds = payload.interface_thresholds if interface_thresholds_provided else {}
    bandwidth_mbps = payload.bandwidth_mbps if bandwidth_mbps_provided else 1000.0
    
    # Preserve previous values when client doesn't provide them
    try:
        current = json.loads(cfg.oids_json or '{}')
        if not thresholds_provided and isinstance(current, dict) and isinstance(current.get('__thresholds__'), dict):
            thresholds = current.get('__thresholds__') or {}
        if not interface_oids_provided and isinstance(current, dict) and isinstance(current.get('__interface_oids__'), dict):
            interface_oids = current.get('__interface_oids__') or {}
        if not interface_thresholds_provided and isinstance(current, dict) and isinstance(current.get('__interface_thresholds__'), dict):
            interface_thresholds = current.get('__interface_thresholds__') or {}
        if not bandwidth_mbps_provided and isinstance(current, dict) and isinstance(current.get('__bandwidth_mbps__'), (int, float)):
            bandwidth_mbps = float(current.get('__bandwidth_mbps__'))
    except Exception:
        pass
    merged = dict(oids)
    # always embed thresholds, interface_oids, interface_thresholds, and bandwidth_mbps (may be empty/default) to ensure persistence in oids_json
    merged['__thresholds__'] = thresholds
    merged['__interface_oids__'] = interface_oids
    merged['__interface_thresholds__'] = interface_thresholds
    merged['__bandwidth_mbps__'] = bandwidth_mbps
    cfg.oids_json = json.dumps(merged)
    db.commit()
    db.refresh(cfg)
    # Build response splitting embedded thresholds, interface_oids, interface_thresholds, and bandwidth_mbps back out
    oids_out = json.loads(cfg.oids_json or '{}')
    thresholds_out = {}
    interface_oids_out = {}
    interface_thresholds_out = {}
    bandwidth_mbps_out = 1000.0
    if isinstance(oids_out, dict):
        if '__thresholds__' in oids_out:
            thresholds_out = oids_out.get('__thresholds__') or {}
        if '__interface_oids__' in oids_out:
            interface_oids_out = oids_out.get('__interface_oids__') or {}
        if '__interface_thresholds__' in oids_out:
            interface_thresholds_out = oids_out.get('__interface_thresholds__') or {}
        if '__bandwidth_mbps__' in oids_out:
            bandwidth_mbps_out = float(oids_out.get('__bandwidth_mbps__', 1000.0))
        oids_out = {k: v for k, v in oids_out.items() if k not in ['__thresholds__', '__interface_oids__', '__interface_thresholds__', '__bandwidth_mbps__', '__selected_interfaces__']}
    return ResourceConfigSchema(
        id=cfg.id,
        community=cfg.community,
        oids=oids_out,
        thresholds=thresholds_out,
        interface_oids=interface_oids_out,
        interface_thresholds=interface_thresholds_out,
        bandwidth_mbps=bandwidth_mbps_out,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )

