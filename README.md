# opencode-mattpocock-skills

An OpenCode plugin that makes the public skills from [mattpocock/skills](https://github.com/mattpocock/skills) available through OpenCode's normal skill discovery.

Install it in OpenCode:

```json
{
  "plugin": [["github:kevbob1/opencode-mattpocock-skills", {
    "updateIntervalHours": 12,
    "exclude": ["in-progress"]
  }]]
}
```

The plugin uses system `git`, `tar`, and Node 20 or newer. It caches a shared bare repository and immutable snapshots under `$XDG_CACHE_HOME/opencode-mattpocock-skills`, or `~/.cache/opencode-mattpocock-skills`. It checks for updates at startup every 24 hours by default. Failed refreshes use the current snapshot; the first refresh must succeed. Restart OpenCode after a refresh for newly fetched skills to take effect.

Tuple options (and `syncSkills(options)`) are: `repository` (`https://github.com/mattpocock/skills.git`), `ref` (`main`), `sourceDirectory` (`skills`), `exclude` (`["in-progress", "misc", "deprecated"]`), `updateIntervalHours` (`24`), `gitTimeoutSeconds` (`30`), `lockTimeoutSeconds` (`300`), and `cacheDirectory` (the cache path above). Git credentials are handled by system Git, so `repository` may point to a fork or private repository.
