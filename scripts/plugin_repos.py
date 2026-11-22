"""The pi marketplace's plugins, listed in plugins.json: an entry with `path` is that folder inside this
repo; an entry with `external` is someone else's plugin, cataloged from the sources it names and never
read locally; any other entry is a sibling folder of this repo.

Shared by write_catalogs.py and lint_plugins.py. `PI_SOURCE` overrides the folder that holds sibling
repos (default: the folder this repo sits in, ~/Source).
"""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def source_dir():
    return Path(os.environ.get("PI_SOURCE", ROOT.parent))


def entries(root=None):
    """The plugins.json entries: name, github (owner/repo) and sha (null until pushed)."""
    return json.loads((Path(root or ROOT) / "plugins.json").read_text())["plugins"]


def repos(root=None, source=None):
    """(entry, repo folder) for each plugin; the folder may be missing on a machine that hasn't cloned it."""
    root = Path(root or ROOT)
    source = Path(source) if source else source_dir()
    return [
        (entry, root / entry["path"] if "path" in entry else source / entry["name"])
        for entry in entries(root)
        if "external" not in entry
    ]


def externals(root=None):
    """The plugins.json entries cataloged from an outside source, with no local folder."""
    return [entry for entry in entries(root) if "external" in entry]


def owner(root=None):
    """The catalog owner's GitHub name (plugins.json `owner`), or None."""
    return json.loads((Path(root or ROOT) / "plugins.json").read_text()).get("owner")


def third_party(entry, catalog_owner):
    """Someone else's plugin: its GitHub owner is not the catalog's. It is cataloged and installed through
    the harness, but this repo neither lints it against CONVENTIONS.md nor runs its install.json."""
    github_owner = entry.get("github", "").split("/")[0]
    return bool(catalog_owner and github_owner and github_owner != catalog_owner)


def own_repos(root=None, source=None):
    """repos() without the third-party ones."""
    catalog_owner = owner(root)
    return [(entry, repo) for entry, repo in repos(root, source) if not third_party(entry, catalog_owner)]
