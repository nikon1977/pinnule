# pinnule

Pinnule is a nimble, lightweight front-facing portal acting as a clean status
window perched atop your local hardware layers. It is fully vibe coded via
multable A.I agents on a free to use bases. Still lots to do but is fully working.

## What it does

- **Auto-detects containers** by talking to the Docker socket directly
  (`dockerode`) - no labels, no config file listing your apps. Anything
  running on the host shows up: name, image, status, ports, and live
  CPU/memory usage per container.
- **Customizable hardware monitor**: CPU load, memory, disk, network
  throughput, temperature, uptime - each panel can be switched on/off from
  the settings drawer (gear icon, top right), along with the poll interval.
  Preferences are saved in the browser (localStorage), so they persist
  across reloads.

## Controlling containers & opening apps

Each card has a start/stop button (top right, next to the name). Stopping
asks for confirmation first since it's disruptive; starting doesn't.

The container name itself is a link - click "adguard" and it opens
AdGuard's dashboard in a new tab. It works by taking the container's first
exposed public port and building `http://<dashboard-host>:<port>`, so it
assumes that first port is the web UI. This will be changed as it is not always correct.

## Deploy it

mkdir -p ~/pinnule
cd ~/pinnule

git clone https://github.com/nikon1977/pinnule.git .

docker compose up -d --build

Visit `http://server-ip:4000`.


## Why host networking

`network_mode: host` is used instead of a `ports:` mapping. Without it, the
container only sees its own virtual network interface, and the NET panel
would show near-zero traffic no matter what the host is actually doing.
Host networking gives it a real view of your NIC. The trade-off: it binds
directly to port 4000 on the host, so make sure nothing else there uses it.

## Disk detection

The DISK panel shows the main disk (`/`) plus anything mounted under
`/mnt/` - other host mounts (`/boot`, `/boot/efi`, docker's internal
overlay mounts, etc.) are filtered out on purpose so the panel only shows
drives you'd actually care about. This relies on the `rslave` propagation
on the bind mount in `docker-compose.yml` - without it, only the root
filesystem would be visible, not other drives mounted under `/mnt/`. If a
drive under `/mnt/` still doesn't show up after rebuilding, check `mount`
on the host for how it's actually attached.

## Why `/:/hostfs:ro`

CPU, memory, and uptime numbers come from `/proc` and `/sys`, which Docker
doesn't sandbox by default - containers already see the host's real
figures for those. Disk usage is different: without a mount, the DISK panel
would report the container's own small overlay filesystem, not your actual
drive. Mounting host root read-only at `/hostfs` fixes that. Nothing is
writable from inside the container.

## If TEMP shows "n/a"

Not every host exposes `/sys/class/thermal` in a way the container can
read (depends on your CPU/motherboard sensors and kernel modules). It's
harmless - just toggle that panel off in settings if it stays empty, or
install `lm-sensors` on the host and re-check.

## Extending it

- `server.js` - two endpoints, `/api/containers` and `/api/system`. Add
  fields here first.
- `public/app.js` - polls those endpoints on an interval and re-renders.
- `public/style.css` - all the CSS custom properties are at the top of the
  file if you want to retheme it.

## App links and icons

Container cards now support optional Docker labels:

- `pinnule.url` — overrides the automatically detected first public port.
- `pinnule.icon` — supplies a custom icon URL.

If no icon label is supplied, the dashboard tries the matching icon from the selfh.st icon set and hides a failed image cleanly. If no URL label is supplied, the first published Docker port remains the automatic app link.

Example:

```yaml
labels:
  - pinnule.url=http://192.168.1.230:8080
  - pinnule.icon=https://example.com/icon.png
```

Container cards also show runtime/creation information and Docker restart counts.
