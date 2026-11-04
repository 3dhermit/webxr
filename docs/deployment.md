# Deployment and dev loops

## The URLs

| URL | Source | Use |
|---|---|---|
| `https://3dhermit.github.io/webxr-first-steps/` | `main` | **the classroom lesson** — what a class loads |
| `https://3dhermit.github.io/webxr-first-steps/next/` | `anatomy-vr` | candidate for side-by-side testing on a second headset |

WebXR requires **HTTPS**, so `file://` and plain http never reach VR mode. GitHub Pages
supplies that for free.

Cache discipline: Pages serves aggressively. Add a cache-buster to a classroom URL when a
lesson changes (`?v=heart1`). Lesson versions are tagged (`git tag heart-lesson-v1`).

## One workflow, one artifact

Free GitHub Pages has **one site per repo**, so two workflows publishing means the last one
wins and silently deletes the other's pages. `deploy.yml` therefore builds both copies and
publishes one combined artifact: `main` → site root, `anatomy-vr` → `/next/`. Triggered by
pushes to either branch; `concurrency.group: pages` keeps deploys serialized.

The subpath works only because webpack sets no `publicPath` and every asset is loaded
relatively. If absolute paths appear, `/next/` breaks first — in CI, before a class sees it.

**Deploys are gated on content**: `npm run validate` runs before build, for both copies. A
malformed `heart.json` would otherwise ship silently to 28 headsets.

## The three dev loops

1. **Local desktop** (`npm run dev` → `https://localhost:8081`, or `npm run build` + a
   static server). Fast numeric/layout probes with the browser tool. Proves geometry,
   layout math, picking and lesson state — never headset performance.
2. **LAN on the real headset** — `npm run dev` serves `0.0.0.0:8081` over HTTPS with a
   self-signed cert; open `https://<PC-IP>:8081` in Quest Browser on the same network and
   accept the cert. This is the loop for anything involving comfort, scale, reach and text.
   If the network blocks it: ADB port forwarding via `chrome://inspect`, or
   `cloudflared tunnel --url http://localhost:8081` (a quick tunnel is a **public** URL —
   stop it when done).
3. **Pages** — merge to `main` and the class URL changes. Treat `main` as "this is the
   lesson the class gets", never a scratch branch.

`metavr` MCP (`npx -y @meta-quest/metavr mcp server`, declared in `.mcp.json`) adds
on-device install/screenshot/perf once the headset is in developer mode over USB; adding it
to `mcp_servers` needs a Hermes restart.

## Reaching up to 28 headsets

Getting a URL onto a cart of headsets is a deployment step, not an app feature:

- **MDM kiosk push** (Meta Quest for Business, ManageXR, ArborXR): the URL launches as the
  kiosk app. Works cleanly here because the app needs no login and resets on every load.
- **Bookmark** per headset: fine for a pilot, fragile across a cart.
- **LAN server** on the classroom machine: avoids both school Wi-Fi filters and the public
  internet; needs the headsets and the machine on one network.

**Check before promising the Pages link**: many school networks block `github.io`. Test from
the actual classroom network the first time, not from a laptop at home.

## Classroom invariants that make any of this work

No accounts, no typing at boot, no backend, no stored records (formative feedback only),
full state reset on every load, and an explicit end state that is ready for the next
student. Every one of those is what lets a URL be handed to a cart without an adult
onboarding each child.
