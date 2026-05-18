import { $ } from 'bun'

const defaultHetznerHost = '178.104.229.113'
const host = process.env.HETZNER_HOST ?? defaultHetznerHost
const user = process.env.HETZNER_USER ?? 'root'
const port = process.env.HETZNER_PORT ?? '22'
const remoteBun = process.env.HETZNER_BUN ?? '/root/.bun/bin/bun'

const target = `${user}@${host}`
const ssh = async (command: string): Promise<void> => {
  await $`ssh -p ${port} ${target} ${command}`
}

await $`bun install --frozen-lockfile`
await $`bun run check`
await $`bun test`
await $`bun run build:ui`

await ssh('mkdir -p /opt/leitbild/app /opt/leitbild/data /opt/leitbild/osrm-data /opt/leitbild/maps/sources /opt/leitbild/maps/builds /opt/leitbild/maps/releases /opt/leitbild/maps/fonts')
await $`rsync -az --delete --exclude node_modules --exclude .git --exclude data -e "ssh -p ${port}" ./ ${target}:/opt/leitbild/app/`

await ssh(`cd /opt/leitbild/app && ${remoteBun} install --frozen-lockfile`)
await ssh(`cd /opt/leitbild/app && ${remoteBun} run build:ui`)
await ssh('cp /opt/leitbild/app/deploy/leitbild.service /etc/systemd/system/leitbild.service')
await ssh('systemctl daemon-reload && systemctl enable --now leitbild && systemctl restart leitbild')
await ssh('curl -fsS http://127.0.0.1:4177/health >/dev/null')

console.log('Leitbild deploy complete')
