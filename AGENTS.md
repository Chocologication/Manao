## SSH Access

- Master node:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@1.12.245.235
  ```

- Node 1:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@193.112.179.183
  ```

- Node 2:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@139.199.194.55
  ```

An SSH tunnel has already been established locally through Xshell, so `kubectl` commands can be used directly.