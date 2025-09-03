from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from app.database.database import engine
from app.models import proxy, proxy_group
from app.models import resource_usage as resource_usage_model
from app.api import proxies, proxy_groups
from app.api import resource_usage as resource_usage_api
import os
from fastapi_standalone_docs import StandaloneDocs

proxy.Base.metadata.create_all(bind=engine)
resource_usage_model.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="PPAT",
    description="Proxy Performance Analysis Tool",
    version="1.0.0"
)
StandaloneDocs(app)

# 템플릿과 정적 파일 설정
templates = Jinja2Templates(directory="app/templates")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

# API 라우터
app.include_router(proxies.router, prefix="/api", tags=["proxies"])
app.include_router(proxy_groups.router, prefix="/api", tags=["proxy-groups"])
app.include_router(resource_usage_api.router, prefix="/api", tags=["resource-usage"])

# 페이지 라우터
@app.get("/{path:path}")
async def read_root(request: Request, path: str = ""):
    return templates.TemplateResponse("components/settings.html", {"request": request})
