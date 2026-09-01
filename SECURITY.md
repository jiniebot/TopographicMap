# Security Policy

Report vulnerabilities privately to the repository owner, not in a public issue. Replace this sentence with a dedicated security contact before publication.

The coordinator is for trusted local networks. It has no authentication and can expose files below the configured DayZ asset root. Keep the localhost default unless workers require LAN access; then use a firewall, VPN, or authenticated reverse proxy.

Never commit `.env`. If a secret was ever committed, remove it from Git history and rotate it before publishing.
