# MCPB bundle

This directory packages `action1-mcp-server` as a [Model Context Protocol Bundle](https://github.com/anthropics/mcpb)
for one-click installation into Claude Desktop.

## Build

The simplest path is the project's own helper:

```bash
npm run build:mcpb       # runs scripts/build-mcpb.sh; emits dist/action1-mcp-<VERSION>.mcpb
```

Or step-by-step:

```bash
npm run build                         # produces dist/
mkdir -p mcpb/server
cp -r dist/* mcpb/server/
cp -r node_modules mcpb/server/node_modules
cp package.json mcpb/server/

npx @anthropic-ai/mcpb pack ./mcpb -o action1-mcp-0.5.0.mcpb
```

The resulting `.mcpb` file can be double-clicked on macOS / Windows with
Claude Desktop installed; Claude Desktop walks the user through filling in
the `user_config` fields (Action1 base URL, org ID, client ID + secret,
allow-destructive switch).

## Distribute

- Email or share-link the `.mcpb` file privately within your team.
- Or submit it to the Anthropic connector directory once the project goes
  public.

## Notes

- The `mcp_config` block uses `${user_config.*}` substitutions, so secrets
  never enter the bundle binary.
- The `ACTION1_ALLOW_DESTRUCTIVE` user_config defaults to `"false"`, which
  is a pragmatic safer default than the env-driven server. Users explicitly
  flip it during setup if they want destructive tools.
- This directory is checked into git but the *built* `.mcpb` artefact is
  not — distribute the artefact via GitHub Releases when the repo goes
  public.
