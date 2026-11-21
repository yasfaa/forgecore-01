# forgecore-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yasfaa/forgecore-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yasfaa/forgecore-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One-process GitHub-compatible git forge: git smart HTTP (upload-pack protocol v2, receive-pack v0),
the REST v3 API, the GraphQL v4 API and a Model Context Protocol endpoint, all served from one
in-memory store by one Node 22 process, with no UI, no dependencies and no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=local-dev-token node main.ts
```

The forge binds an ephemeral port, registers it with the suite at `MAKEFUN_ENV_URL`, serves until
the suite answers `{"done": true}` and exits 0. Point the kit's local runner at it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token local-dev-token
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=f7smpc1q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
