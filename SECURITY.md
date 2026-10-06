# Security

IdleCrash plays with fake tokens only. Even so, the server is on the internet and the mod runs on your machine.

If you find a way to cheat, crash the server, read someone else's account, or make the mod do something
it should not, please open a private report: <https://github.com/grozoww/idlecrash/security/advisories/new>.
Please do not post it as a public issue first.

What the mod does on your machine, in full: it calls the server's `/account`, `/join`, `/presence`, `/state`,
`/bet`, `/cashout`, `/leave` and `/top` endpoints and shows a pane and toasts. It runs no program and reads
and writes only its own plugin store (an anonymous id, a secret, your nickname and one setting). It never
reads your prompts, files or code.
