# Move the "office" editor to your own server (Oracle Cloud)

This stands up your own **OnlyOffice Document Server** at
`https://docs.connexiontwo.com`, so Word/Excel/PowerPoint files open on **your**
infrastructure instead of the third-party `docs.bisondoc.com`.

## Part 1 — Oracle Cloud VM
1. **Create the VM.** OCI Console → Compute → Instances → Create. Use the
   Always-Free **Ampere (ARM)** shape, Ubuntu 22.04. Give it a public IP.
2. **Open the ports.** In the VM's subnet Security List (and the OS firewall),
   allow inbound **80** and **443**.
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
3. **DNS.** In your domain's DNS, add an **A record**:
   `docs.connexiontwo.com` → the VM's public IP. Wait for it to resolve.

## Part 2 — Install Docker + run the server
```bash
# on the VM
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# copy this deploy/onlyoffice folder onto the VM, then:
cd onlyoffice
cp .env.example .env
# put a real secret in .env:
sed -i "s/replace_with_a_long_random_secret/$(openssl rand -hex 32)/" .env

docker compose up -d
```
Give it 1–2 minutes, then open **https://docs.connexiontwo.com** — you should see
the OnlyOffice welcome page with a valid certificate. Note the secret you set:
```bash
grep ONLYOFFICE_JWT_SECRET .env
```

## Part 3 — Point Connexion Two at the new server
1. **Vercel env:** set `ONLYOFFICE_JWT_SECRET` to the exact value from `.env`
   above, then redeploy. (This is what `api/onlyoffice-config.js` signs with.)
2. **Front end:** the editor script host is already switched to
   `docs.connexiontwo.com` in `welcome.html` and `welcome-2.html`.
   **Deploy those two files only after Part 2 shows the OnlyOffice page live** —
   otherwise the editor can't load.

## Verify
Open a document from your workspace. It should open in the editor served from
`docs.connexiontwo.com` (check the Network tab — requests go to your domain, not
bisondoc). Edits should save (the callback hits `/api/onlyoffice-callback`).

## Rollback
If anything's off, revert the two script tags to
`https://docs.bisondoc.com/web-apps/apps/api/documents/api.js` and set
`ONLYOFFICE_JWT_SECRET` back to the bisondoc secret.

## Ongoing (this is the "€49/month security & maintenance")
- Update: `docker compose pull && docker compose up -d`
- Back up the `data/` folder.
- Watch disk usage; OCI Always-Free has limits — heavy use may need a bigger shape.
