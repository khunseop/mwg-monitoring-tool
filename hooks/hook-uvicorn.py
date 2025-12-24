# PyInstaller hook for uvicorn

from PyInstaller.utils.hooks import collect_data_files, copy_metadata, collect_submodules

datas = collect_data_files('uvicorn', include_py_files=True)
datas += copy_metadata('uvicorn')

hiddenimports = [
    'uvicorn',
    'uvicorn.lifespan',
    'uvicorn.logging',
    'uvicorn.config',
    'uvicorn.main',
    'uvicorn.loops.auto',
    'uvicorn.loops.uvloop',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.supervisors.multiprocess',
    'uvicorn.supervisors.statreload',
]

# Collect all uvicorn submodules to ensure nothing is missing
hiddenimports.extend(collect_submodules('uvicorn'))

