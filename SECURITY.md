# Security policy

MemoryVault binds to `127.0.0.1` by default. Keep that default unless remote
clients must connect. If you bind to a public or shared interface, set a strong
`MEMORYVAULT_PASSWORD` and protect the TCP connection with a private network or
TLS-terminating proxy; the custom protocol itself is not encrypted.

Do not commit passwords or AOF data. The default AOF and `.env` files are
excluded from Git.

To report a vulnerability, use GitHub's private vulnerability reporting for
this repository when available. Do not disclose an unpatched vulnerability in
a public issue.
