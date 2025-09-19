from PyInstaller.utils.hooks import collect_data_files, copy_metadata

datas = collect_data_files('fastapi_standalone_docs', include_py_files=True)
datas += copy_metadata('fastapi_standalone_docs')

hiddenimports = [
    'fastapi_standalone_docs',
]

