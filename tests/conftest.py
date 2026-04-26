"""Make `harvester/` modules importable as top-level (matches harvest.py)."""
import sys
from pathlib import Path

HARVESTER = Path(__file__).resolve().parent.parent / "harvester"
if str(HARVESTER) not in sys.path:
    sys.path.insert(0, str(HARVESTER))
