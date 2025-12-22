# PyInstaller hook for SQLAlchemy
# Ensures SQLAlchemy dialects including sqlite are included

from PyInstaller.utils.hooks import collect_submodules

# Collect all SQLAlchemy submodules including dialects
hiddenimports = collect_submodules('sqlalchemy')

# Explicitly include sqlite dialect
hiddenimports.extend([
    'sqlalchemy.dialects.sqlite',
    'sqlalchemy.dialects.sqlite.pysqlite',
])

