# Connexion Two scanner — copy to ".env" on the VM and fill in.
# Generate the token with:  openssl rand -hex 32
# The SAME value must be set as SCANNER_TOKEN in your Supabase edge function secrets.
SCANNER_TOKEN=replace_with_a_long_random_secret

# Optional tuning (defaults shown)
# MAX_FILE_MB=25
# STALE_DEFS_DAYS=3      # refuse to scan if virus definitions are older than this
# STRICT_TYPES=false     # true = accept ONLY known-good document/image types
# PORT=8080
# CLAMD_HOST=127.0.0.1
# CLAMD_PORT=3310
