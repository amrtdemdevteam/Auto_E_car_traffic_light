# Git Push / Raspberry Pi Pull Workflow

## First push from your PC

```bash
cd trafficlight
git init
git add .
git commit -m "Traffic light normal junction V1"
git branch -M main
git remote add origin <YOUR_GIT_REPO_URL>
git push -u origin main
```

## First install on Raspberry Pi

```bash
cd ~
git clone <YOUR_GIT_REPO_URL> trafficlight
cd ~/trafficlight
sudo ./install.sh
```

The installer copies runtime files to `/opt/trafficlight`; Git working files remain in `~/trafficlight`.

## Later update

```bash
cd ~/trafficlight
git pull
./scripts/self_test.sh
sudo ./install.sh
sudo systemctl restart trafficlight
sudo journalctl -u trafficlight -f
```

`/etc/trafficlight/settings.json` is not overwritten by reinstall, so field-tuned settings survive Git updates.

## Never commit
- Wi-Fi passwords
- `/etc/trafficlight/settings.json` from a production Pi unless secrets are removed
- logs
- `.pio/` build cache
