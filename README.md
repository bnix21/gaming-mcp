# gaming-mcp

An MCP server for checking games across Steam, Xbox Game Pass, and GeForce Now — no API keys required.

## Tools

| Tool | Description |
|------|-------------|
| `check_game_everywhere` | One-shot check: Steam price/discount, Game Pass, GeForce Now, Steam Deck rating, macOS support |
| `search_steam` | Search Steam for a game, returns price and active discounts |
| `get_steam_deals` | Top Steam deals sorted by discount percentage |
| `check_game_pass` | Check if a game is in the Xbox PC Game Pass catalog |
| `check_geforce_now` | Check if a game is supported on NVIDIA GeForce Now |

## Setup

```bash
npm install
```

## Claude Desktop config

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gaming-deals": {
      "command": "node",
      "args": ["/path/to/this/repo/index.js"]
    }
  }
}
```

## Notes

- Uses only public APIs — no authentication needed
- Game Pass catalog is fetched live on first use (10–20s), then cached for the session
- GeForce Now catalog may lag behind newly added titles; unknown results link to the official list
