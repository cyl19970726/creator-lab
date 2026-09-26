#!/usr/bin/env python3
"""Make an explicit read-only viewing snapshot; never copy an active SQLite file."""
import argparse
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True, help="Existing runtime directory")
parser.add_argument("--output", required=True, help="New, non-existing snapshot directory")
args = parser.parse_args()
source = Path(args.source).resolve()
output = Path(args.output).resolve()
database = source / "self-media.sqlite"
if not database.is_file() or not (source / "runs").is_dir():
    parser.error("Source needs self-media.sqlite and runs/")
if output.exists():
    parser.error("Output must not exist; snapshots never overwrite a runtime")
output.mkdir(parents=True)
with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as original:
    with sqlite3.connect(output / "self-media.sqlite") as snapshot:
        original.backup(snapshot)
(output / "runs").symlink_to(source / "runs", target_is_directory=True)
print(f"Snapshot: {output}")
print("Media/report files remain at source. Start ONLY with SELF_MEDIA_READ_ONLY=true.")
