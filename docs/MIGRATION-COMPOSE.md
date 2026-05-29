# Docker Compose Migration Plan

> Status: in-progress on branch `feature/compose-migration`
> Target version: 0.2.0 (breaking change)

## 0. Goals and constraints

**Goals**
- Move from per-env Dockerfile mode to **per-project Docker Compose stack**.
- Compose unit = **1 project = 1 docker-compose.yml**.
- Enable inter-env communication within a project (DNS by service name).
- Explicit network control for env-to-env and env-to-host.
- Inherit all existing features (firewall, shared volume, templates, baseImage, isolation between projects).

**Constraints**
- Stay within VS Code Dev Containers `dockerComposeFile` semantics.
- Preserve the core isolation story (per-project boundary, workspace isolation, per-env home volume).
- Provide a migration path for existing envs (manual command, not automatic).
- Land on branch `feature/compose-migration`; keep `main` at 0.1.0 until merge.

---

## 1. Architecture migration

### Before (current — dockerfile mode)

```
<project>/
  env1/.devcontainer/
    Dockerfile
    init-firewall.sh
    devcontainer.json   (build.dockerfile = Dockerfile)
  env2/.devcontainer/
    ...

Docker:
  default bridge network, no inter-env DNS
  vsc-env1-<hash> + vsc-env2-<hash> images
  containers labeled cpt.project / cpt.env
```

### After (compose mode)

```
<project>/
  .devcontainer/                    ← project-level scaffolding
    docker-compose.yml              # services: env1, env2, …
    docker-compose.override.yml     # optional dev-time tweaks
  env1/.devcontainer/
    Dockerfile
    init-firewall.sh
    devcontainer.json   (dockerComposeFile + service: env1)
  env2/.devcontainer/
    ...

Docker:
  cpt-<project>-net                 ← project-scoped user-defined network
  cpt-<project>_env1, _env2         ← service name = container name (DNS resolvable)
  per-service image: cpt-<project>-env1
```

### Compose YAML shape

```yaml
name: cpt-<project>

services:
  env1:
    build:
      context: ../env1/.devcontainer
      dockerfile: Dockerfile
    container_name: cpt-<project>-env1
    hostname: env1
    cap_add: [NET_ADMIN, NET_RAW]
    labels:
      cpt.project: "<project>"
      cpt.env: "env1"
    networks:
      cpt-net:
        aliases: [env1]
    volumes:
      - env1-src:/workspace
      - env1-home:/home/dev
      - shared:/shared        # only when shared volume enabled
    extra_hosts:
      - "host.docker.internal:host-gateway"   # only when host access allowed
    command: sleep infinity

  env2:
    # similar

networks:
  cpt-net:
    name: cpt-<project>-net
    driver: bridge

volumes:
  env1-src:
  env1-home:
  env2-src:
  env2-home:
  shared:                     # only when shared volume enabled
```

### Per-env devcontainer.json (compose reference)

```jsonc
{
  "name": "<project> / env1",
  "dockerComposeFile": ["../../.devcontainer/docker-compose.yml"],
  "service": "env1",
  "workspaceFolder": "/workspace",
  "remoteUser": "dev",
  "shutdownAction": "stopContainer",   // stop this env only (others stay running)
  "customizations": { ... },
  "containerEnv": { "CLAUDE_CONFIG_DIR": "/home/dev/.claude" }
}
```

---

## 2. Network management (new)

### Default behavior

| Traffic | Default | Control point |
|---|---|---|
| Same-project env to env | **allowed** (`http://env2:port`) | compose `networks` |
| Across-project env | denied (separate network) | full isolation |
| Container to host | via `host.docker.internal` | `extra_hosts` |
| Container to internet | firewall=off allow / firewall=on allowlist | existing `init-firewall.sh` |
| Host to container | only when `ports` is published | `ports` mapping |

### New setting: per-project network policy

`cpt.projects[].network` (optional):

```jsonc
{
  "network": {
    "interEnv": "allow",        // "allow" | "deny"
    "host": "allow",            // "allow" | "deny"
    "publishPorts": []          // [{ env, container, host }] for host port mapping
  }
}
```

Behavior:
- `interEnv: "deny"` → each env on a separate network, no service-name resolution.
- `host: "deny"` → omit `extra_hosts`; firewall script also blocks host-gateway IP.
- `publishPorts` → injected into the relevant service's `ports`.

### Firewall (`init-firewall.sh`) adjustments

When the project network is shared, the allowlist auto-extends to include the compose network CIDR so:
- firewall=on still allows env-to-env within the same project.
- firewall=on continues to block other projects (they live on a different network — they physically cannot reach this one).

---

## 3. Extension code impact

### Logic that changes substantially

| File / function | Change |
|---|---|
| `devcontainerJson()` | Switch to compose-reference shape (`dockerComposeFile` / `service`). |
| **new** `composeYaml()` | Generate the project-level compose YAML. |
| `writeAnchor()` | Write both per-project and per-env files. |
| **new** `writeProjectAnchor()` | Append / regenerate `<project>/.devcontainer/docker-compose.yml`. |
| `addEnvironment` | Append a service to compose. |
| `removeEnvironment` | Remove a service from compose. |
| `removeProject` | `docker compose down` + network removal. |
| `rebuild` | `docker compose build --no-cache <svc>` + `up -d <svc>`. |
| `cpt.stop` | `docker compose stop <svc>`. |
| `cpt.open` | compose up + Dev Containers reopenInContainer (unchanged for the Dev Containers handoff). |
| `setFirewall` | Toggle via service labels or env vars instead of `postStartCommand`. |
| `toggleShared` | Edit compose `volumes` and each service's `volumes`. |
| `envVolumeRoles` | Match compose volume naming (`<stack>_<volname>`). |
| `VolumeProvider` | Group via compose project name; also consult `docker compose ls`. |
| `resyncTemplate` | Regenerate per-env files + project-level compose. |
| **new** `cpt.openProjectStack` | Project right-click — bring whole stack up. |
| **new** `cpt.stopProjectStack` | Project right-click — bring whole stack down. |

### Compose wrapper

A new helper `composeRun(env, args)` to absorb WSL vs Docker Desktop differences:
- WSL: `wsl.exe -d <distro> docker compose -p cpt-<project> -f <path> <args>`
- Local: `docker compose -p cpt-<project> -f <path> <args>`

### New setting schema

```jsonc
"cpt.projects[].network": { ... },
"cpt.projects[].compose": {
  "additionalServices": []        // reserved for future sidecar definitions
}
```

---

## 4. Phased implementation

### Phase 0 — Branch + this plan
- Branch `feature/compose-migration` created.
- `docs/MIGRATION-COMPOSE.md` (this file) committed.

### Phase 1 — Minimal compose migration (feature parity)
Run all existing flows through compose, without yet exposing the new network options.

1. Implement `composeYaml()`.
2. Rewrite `devcontainerJson()` to the compose-reference shape.
3. Split `writeAnchor()` into per-project + per-env writers.
4. Update `addEnvironment` / `removeEnvironment` to mutate compose services.
5. Update `cpt.open` flow to do `compose up -d <service>` before the Dev Containers handoff.
6. Update `cpt.stop` to call `docker compose stop`.
7. Update `cpt.rebuild` to call `docker compose build --no-cache` + `up -d`.
8. Update `removeProject` to call `docker compose down -v` and remove the network.
9. Update `envVolumeRoles` for compose naming.
10. Manual E2E: new project / env creation, Open, Stop, Rebuild, Delete — same UX as before.

### Phase 2 — (skipped)
Decided 2026-05-29 to drop backwards compatibility entirely (single-user repo, no existing envs in `cpt.projects`). Compose-only from 0.2.0; the user clears any pre-existing envs before upgrading.

### Phase 3 — Network policy enabled
1. Add `cpt.projects[].network` schema.
2. Reflect network policy in compose generation:
   - `interEnv: "allow"` (default) → all services on `cpt-<project>-net`.
   - `interEnv: "deny"` → each service on its own network.
   - `host: "allow"` (default) → emit `extra_hosts: host.docker.internal:host-gateway`.
   - `publishPorts` → add `ports` to the relevant services.
3. Extend `init-firewall.sh` to allow the compose-network CIDR automatically.

### Phase 4 — UX polish
1. Project right-click: `Start all` / `Stop all`.
2. Tree shows project-level network state (running service count, network name).
3. `Edit compose file` command (project right-click).
4. Volume panel aligned with compose naming.

### Phase 5 — Documentation and release
1. Update README for compose mode.
2. CHANGELOG documents the breaking change.
3. Bump 0.1.0 → **0.2.0**.
4. Merge to main, push, build VSIX, distribute.

---

## 5. Migration / compatibility

**No backwards compatibility.** Single-user repo, clean break. Compose-only from 0.2.0.

The user clears `cpt.projects` (and removes any leftover anchors / containers / volumes manually) before upgrading. No `build`-field detection, no fallback code paths, no migration tooling — keeps the implementation 30–40 % smaller.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dev Containers compose-mode quirks (workspaceFolder, `shutdownAction`, `runServices`, …) | Land Phase 1 E2E first; iterate on behavior. |
| Compose volume naming changes (`<stack>_<name>` prefix), incompatible with existing volumes | Leave old volumes as-is, start the new stack with fresh volumes, document manual data migration. |
| Firewall vs compose embedded DNS interaction | Service-name resolution uses Docker's embedded DNS, runs outside firewall scope — revalidate. |
| Old-format Rebuild path breaks under compose-aware code | Branch on `dockerComposeFile` vs `build` in devcontainer.json. |
| Compose initial bring-up is slower than single container | Reuse the existing WSL handoff progress UI. |
| Shared volume removal during project delete | Same confirmation dialog as today. |

---

## 7. Open questions

1. `shutdownAction`: stop only the affected env (`stopContainer`), the whole stack (`stopCompose`), or nothing (`none`)?
   - **Tentative**: `stopContainer` (other envs stay running).
2. `container_name` collision risk if the same project name exists at different paths.
   - **Tentative**: include a hash of WSL distro + workspace path.
3. Use `network.internal: true` as a defence-in-depth option for projects that don't want external egress at all?
4. What to do with legacy `claude-code-config-*` / `claude-code-bashhistory-*` volumes from pre-0.0.91 envs?
   - Same answer as before: leave them; manual cleanup via Volume panel.
5. The Dev Containers `vscode` volume in compose mode — confirm Dev Containers still attaches it `external=true`.

---

## 8. Decision log

- 2026-05-29: branch `feature/compose-migration` created at commit `46d337d`. Plan committed as the first step of Phase 0.
