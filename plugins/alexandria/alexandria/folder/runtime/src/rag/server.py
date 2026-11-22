"""Builds the MCP server from the tool registry.

Nothing here knows what any individual tool does. The registry is the only place
tools are declared, and this is the only place they are bound.
"""

from mcp.server import MCPServer

from rag.tools import REGISTRY

SERVER_NAME = "rag"


def build_server() -> MCPServer:
    """Return a server with every registry entry bound, and nothing else."""
    server = MCPServer(SERVER_NAME)
    for spec in REGISTRY:
        server.add_tool(spec.fn, name=spec.name, description=spec.description)
    return server
