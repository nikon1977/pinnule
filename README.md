# Pinnule

**A nimble, lightweight dashboard for your homelab.**

Pinnule is a lightweight front-facing portal that sits on top of your local infrastructure and gives you a clean, real-time view of your Docker containers and host hardware.

It automatically discovers running containers, displays system statistics, and provides quick access to your applications — with minimal configuration.

> **Built entirely through vibe coding with multiple AI agents.**
>
> It's very much a work in progress, but it's already fully functional and useful.

---

## ✨ Features

### 🐳 Automatic container discovery

Pinnule talks directly to the Docker socket using [`dockerode`](https://github.com/apocas/dockerode).

There is **no app configuration file** and no need to manually list your containers.

For each container Pinnule can display:

* Container name
* Docker image
* Running/stopped status
* CPU usage
* Memory usage
* Runtime information
* Creation time
* Docker restart count

Anything running on the Docker host can automatically appear on the dashboard.

---

### 🖥️ Hardware monitoring

Pinnule provides a configurable overview of the host system, including:

* CPU load
* Memory usage
* Disk usage
* Network throughput
* Temperature
* System uptime

The hardware panels can be enabled or disabled from the **Settings** drawer using the gear icon.

The polling interval is also configurable.

Your preferences are stored in the browser using `localStorage`, so they persist between page reloads.

---

## 🚀 App links & icons

Pinnule can automatically turn Docker containers into clickable application cards.

By default, it uses the container's **first published Docker port** to build the application URL.

For example:

```text
http://192.168.1.230:8080
```

This works well for many applications, but isn't always correct.

### Docker labels

You can override the automatic behaviour with optional Docker labels:

```yaml
labels:
  - pinnule.url=http://192.168.1.230:8080
  - pinnule.icon=https://example.com/icon.png
```

#### `pinnule.url`

Overrides the automatically detected application URL.

#### `pinnule.icon`

Provides a custom icon URL.

If no icon is specified, Pinnule automatically attempts to find a matching icon from the [Selfh.st Icons](https://selfh.st/icons/) collection.

If an icon cannot be found, it is hidden cleanly rather than leaving a broken-image placeholder.

---

## 🎮 Controlling containers

Each container card includes a start/stop control.

### Start

Starting a container happens immediately.

### Stop

Stopping a container requires confirmation because it can interrupt a running application.

The container name itself is also clickable when an application URL can be determined.

---

## 📦 Deployment

Pinnule is designed to be very simple to deploy.

### Clone the repository

```bash
mkdir -p ~/pinnule
cd ~/pinnule

git clone https://github.com/nikon1977/pinnule.git .
```

### Start Pinnule

```bash
docker compose up -d --build
```

Once the container has started, open:

```text
http://SERVER-IP:4000
```

For example:

```text
http://192.168.1.230:4000
```

---

## 🌐 Why host networking?

Pinnule uses:

```yaml
network_mode: host
```

rather than a Docker `ports:` mapping.

This is important for the network monitoring functionality.

With normal Docker networking, Pinnule would see the container's virtual network interface rather than the host's actual network traffic.

Host networking allows Pinnule to see the real network interface and therefore report meaningful network throughput.

### The trade-off

Pinnule binds directly to port `4000` on the Docker host.

Make sure another application isn't already using that port.

---

## 💾 Disk detection

The **DISK** panel displays:

* The main `/` filesystem
* Filesystems mounted under `/mnt/`

Other mounts such as:

* `/boot`
* `/boot/efi`
* Docker overlay filesystems
* Other internal mounts

are intentionally filtered out.

The goal is to show the disks and mounts that are actually useful to a homelab user.

This relies on `rslave` mount propagation in `docker-compose.yml`.

Without it, Pinnule may only see the root filesystem and not additional drives mounted beneath `/mnt/`.

If a drive still doesn't appear after rebuilding Pinnule, check the host with:

```bash
mount
```

---

## 🔒 Why `/:/hostfs:ro`?

Pinnule needs access to some information from the Docker host.

CPU, memory and uptime information comes from:

```text
/proc
/sys
```

Docker already exposes these areas sufficiently for Pinnule to read the host's statistics.

Disk usage is different.

Without access to the host filesystem, Pinnule would see the container's own Docker overlay filesystem instead of the actual host disks.

The solution is to mount the host filesystem read-only:

```text
/:/hostfs:ro
```

This allows Pinnule to inspect the host filesystem without giving it write access.

**Nothing inside the container can write to the host through this mount.**

---

## 🌡️ If TEMP shows `n/a`

Temperature monitoring depends on what sensors your hardware and kernel expose through:

```text
/sys/class/thermal
```

Some systems simply don't expose usable temperature information there.

If temperature remains unavailable, you can either:

1. Disable the TEMP panel in Pinnule's settings, or
2. Install `lm-sensors` on the host and check whether additional sensors become available.

This is harmless and does not affect the rest of Pinnule.

---

## 🛠️ Extending Pinnule

The project is intentionally simple and easy to modify.

### `server.js`

Provides the backend API:

```text
/api/containers
/api/system
```

Add new backend information here first.

### `public/app.js`

Polls the API and updates the dashboard.

### `public/style.css`

Contains the dashboard styling.

CSS custom properties are located near the top of the file, making it easy to change the theme.

---

## 🤖 Development

Pinnule was built using a **vibe-coding workflow with multiple AI agents**.

The project is intentionally kept relatively small and straightforward so that it remains easy to understand, modify and experiment with.

There is still plenty I'd like to add.

---

## 📋 Roadmap

Pinnule is already functional, but there is plenty of room for improvement.

Some areas I'd like to explore:

* Better application URL detection
* More container controls
* Additional hardware metrics
* More detailed network information
* Improved application discovery
* More dashboard customisation
* More configuration options

---

## 📄 License

Pinnule is released under the **MIT License**.

See [`LICENSE`](LICENSE) for the full license text.

---

## 👤 Author

Created by **nikon1977**.

GitHub:
https://github.com/nikon1977

---

## ⭐ If you find Pinnule useful

If Pinnule is useful in your homelab, consider giving the project a ⭐ on GitHub.

Feedback, ideas and contributions are welcome.
