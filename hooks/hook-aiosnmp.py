from PyInstaller.utils.hooks import collect_data_files, copy_metadata

# Ensure aiosnmp package files and metadata are bundled
datas = collect_data_files('aiosnmp', include_py_files=True)
datas += copy_metadata('aiosnmp')

# aiosnmp depends on asyncio_dgram and pyasn1
hiddenimports = [
    'asyncio_dgram',
    'pyasn1',
    'pyasn1.type',
    'pyasn1.codec',
    'pyasn1.codec.ber',
]

