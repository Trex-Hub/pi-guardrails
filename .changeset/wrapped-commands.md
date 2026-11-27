---
"@aliou/pi-guardrails": patch
---

Built-in dangerous-command detection now sees through wrappers (`env`, `nohup`, `nice`, `timeout`, `command`, `exec`, `stdbuf`, `xargs`, `find -exec`, `sh -c`, `eval`, absolute paths like `/usr/bin/sudo`, and others). Some commands that were previously missed, such as `env X=1 sudo ls`, `nohup rm -rf build` and `bash -c 'sudo ls'`, are now flagged.
