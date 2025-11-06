# A CDN for your needs
We combine speed with cdn making the fastest CDN running on your server with low latency and no memory leaks, made in RUST for low-usage.

# One-line command to install ADEdge
```bash
git clone https://github.com/antonndev/ADEdge.git && cd ADEdge && curl https://sh.rustup.rs -sSf | sh -s -- -y && source $HOME/.cargo/env && cargo build --release && cargo run
```
For Termux:
```bash
hash -r && export PATH="/data/data/com.termux/files/usr/bin:$PATH" && /data/data/com.termux/files/usr/bin/cargo --version && cd ~ && git clone https://github.com/antonndev/ADEdge.git || true && cd ADEdge && /data/data/com.termux/files/usr/bin/cargo build --release && /data/data/com.termux/files/usr/bin/cargo run
```
