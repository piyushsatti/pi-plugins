"""The registry and the server's bound tools must be the same set.

This is the test that stops the two drifting: adding a ToolSpec without binding it,
or binding something that is not in the registry, both fail here.
"""

from memory.server import build_server
from memory.tools import REGISTRY


async def bound_tool_names() -> set[str]:
    return {tool.name for tool in await build_server().list_tools()}


async def test_every_registry_entry_is_bound_and_no_others():
    assert await bound_tool_names() == {spec.name for spec in REGISTRY}


async def test_descriptions_reach_the_wire():
    """A tool with no description is a tool a model will use wrongly."""
    tools = {t.name: t for t in await build_server().list_tools()}
    for spec in REGISTRY:
        assert tools[spec.name].description == spec.description
        assert spec.description.strip(), f"{spec.name} has an empty description"
